import OpenAI from "openai";
import { extractAllowedResumeText } from "../utils/resumeSections.js";
import { extractStarredItems } from "../utils/jdPriority.js";
import { detectHardBlockers } from "../utils/optBlockers.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TIER_POINTS = { Exact: 1.0, Close: 0.8, Partial: 0.5, Missing: 0.0 };
const SKILL_POINTS = { Exact: 1.0, Close: 0.85, Partial: 0.5, Missing: 0.0 };
const PRIORITY_WEIGHT = { must_have: 1.6, preferred: 1.2, unspecified: 1.0 };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uniq(arr) {
  const out = [];
  const seen = new Set();

  for (const item of arr || []) {
    const val = String(item || "").trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }

  return out;
}

function computeMatchScore(requirements) {
  const items = Array.isArray(requirements) ? requirements : [];
  if (!items.length) return 0;

  const sum = items.reduce((acc, r) => acc + (TIER_POINTS[r?.match_level] ?? 0), 0);
  return Math.round((sum / items.length) * 1000) / 10;
}

function isSkillsOrToolsCategory(category) {
  const c = String(category || "").toLowerCase();
  return c.includes("tools") || c.includes("skills");
}

function computeSkillsEligibility(requirements = []) {
  const items = (Array.isArray(requirements) ? requirements : []).filter((r) =>
    isSkillsOrToolsCategory(r?.category)
  );

  const total = items.length;
  if (!total) {
    return {
      skills_total: 0,
      skills_matched: 0,
      skills_partial: 0,
      skills_missing: 0,
      missing_must_have: 0,
      missing_preferred: 0,
      skills_coverage_pct: 0,
      penalty_points: 0,
      eligibility_pct: 0,
      improvement_potential_pct: 0,
    };
  }

  let weightedSum = 0;
  let weightedTotal = 0;

  let matched = 0;
  let partial = 0;
  let missing = 0;
  let missMust = 0;
  let missPref = 0;
  let missUnspec = 0;

  for (const r of items) {
    const level = r?.match_level;
    const priority = r?.priority || "unspecified";

    const weight = PRIORITY_WEIGHT[priority] ?? 1.0;
    const points = SKILL_POINTS[level] ?? 0;

    weightedSum += points * weight;
    weightedTotal += weight;

    if (level === "Missing") {
      missing++;
      if (priority === "must_have") missMust++;
      else if (priority === "preferred") missPref++;
      else missUnspec++;
    } else {
      matched++;
      if (level === "Partial") partial++;
    }
  }

  const skillsCoveragePct = weightedTotal
    ? Math.round((weightedSum / weightedTotal) * 100)
    : 0;

  const penalty = missMust * 12 + missPref * 6 + missUnspec * 2;
  const eligibilityPct = clamp(skillsCoveragePct - penalty, 0, 100);
  const improvementPotentialPct = Math.round(
    ((partial + missPref + missUnspec) / total) * 100
  );

  return {
    skills_total: total,
    skills_matched: matched,
    skills_partial: partial,
    skills_missing: missing,
    missing_must_have: missMust,
    missing_preferred: missPref,
    skills_coverage_pct: skillsCoveragePct,
    penalty_points: penalty,
    eligibility_pct: eligibilityPct,
    improvement_potential_pct: improvementPotentialPct,
  };
}

function computeVerdict({
  blocked = false,
  rawScore = 0,
  missingMustHaveCount = 0,
  missingPreferredCount = 0,
  experienceMatch = null,
  locationMatch = null,
}) {
  if (blocked) {
    return {
      fit_score: 0,
      verdict: "BLOCKED",
      time_worthiness: "LOW",
      tailoring_effort: "HIGH",
    };
  }

  let score = Number(rawScore) || 0;

  score -= missingMustHaveCount * 10;
  score -= missingPreferredCount * 4;

  if (experienceMatch === true) score += 6;
  if (experienceMatch === false) score -= 8;

  if (locationMatch === true) score += 3;
  if (locationMatch === false) score -= 4;

  score = clamp(Math.round(score), 0, 100);

  let verdict = "SKIP";
  if (score >= 85) verdict = "APPLY_NOW";
  else if (score >= 70) verdict = "APPLY_WITH_TAILORING";
  else if (score >= 55) verdict = "STRETCH_APPLY";
  else verdict = "SKIP";

  let timeWorthiness = "LOW";
  if (verdict === "APPLY_NOW") timeWorthiness = "HIGH";
  else if (verdict === "APPLY_WITH_TAILORING") timeWorthiness = "MEDIUM";
  else if (verdict === "STRETCH_APPLY") timeWorthiness = "MEDIUM";

  let tailoringEffort = "HIGH";
  if (missingMustHaveCount === 0) tailoringEffort = "LOW";
  else if (missingMustHaveCount <= 2) tailoringEffort = "MEDIUM";

  return {
    fit_score: score,
    verdict,
    time_worthiness: timeWorthiness,
    tailoring_effort: tailoringEffort,
  };
}

function buildDecisionReasons({
  blockerText = null,
  matchedSkills = [],
  missingMustHaveSkills = [],
  missingPreferredSkills = [],
  experienceMatch = null,
  locationMatch = null,
}) {
  const reasons = [];

  if (blockerText) {
    reasons.push("This role has a hard requirement you likely cannot satisfy.");
  }

  if (matchedSkills.length) {
    reasons.push(`Strong overlap in core skills: ${matchedSkills.slice(0, 3).join(", ")}.`);
  }

  if (missingMustHaveSkills.length) {
    reasons.push(
      `Missing must-have requirements: ${missingMustHaveSkills.slice(0, 3).join(", ")}.`
    );
  } else if (missingPreferredSkills.length) {
    reasons.push(
      `Mostly preferred gaps remain: ${missingPreferredSkills.slice(0, 3).join(", ")}.`
    );
  }

  if (experienceMatch === false) {
    reasons.push("Experience level appears below the role requirement.");
  } else if (experienceMatch === true) {
    reasons.push("Experience level appears aligned with the role.");
  }

  if (locationMatch === false) {
    reasons.push("Location or work-mode may not be compatible.");
  } else if (locationMatch === true) {
    reasons.push("Location or work-mode appears compatible.");
  }

  return reasons.slice(0, 3);
}

function wrapReport(body) {
  return `REPORT (conversational analysis):\n"""\n${body}\n"""`;
}

function buildBlockerReport({ blocker, job_title }) {
  const position = job_title || "Not provided";

  const body =
    `🚫 APPLICATION BLOCKED

Position: ${position}

BLOCKER IDENTIFIED:
- ${blocker.blocker_text}

WHY THIS ROLE IS NOT WORTH APPLYING TO:
This job posting contains a hard restriction such as citizenship, clearance, permanent residency, or export-control language.

RECOMMENDATION:
Skip this role and spend your time on jobs without this blocker.`;

  return body;
}

function buildReport({ fitScore, verdict, matchedSkills, missingMustHave, missingPreferred, summaryText }) {
  const lines = [];

  lines.push(`Verdict: ${verdict}`);
  lines.push(`Fit Score: ${fitScore}%`);
  lines.push("");

  lines.push("Top matched skills:");
  if (matchedSkills.length) {
    for (const item of matchedSkills.slice(0, 5)) lines.push(`- ${item}`);
  } else {
    lines.push("- None clearly matched.");
  }

  lines.push("");
  lines.push("Missing must-have skills:");
  if (missingMustHave.length) {
    for (const item of missingMustHave.slice(0, 5)) lines.push(`- ${item}`);
  } else {
    lines.push("- No major must-have gaps found.");
  }

  lines.push("");
  lines.push("Missing preferred skills:");
  if (missingPreferred.length) {
    for (const item of missingPreferred.slice(0, 5)) lines.push(`- ${item}`);
  } else {
    lines.push("- No major preferred gaps found.");
  }

  lines.push("");
  lines.push("Summary:");
  lines.push(summaryText);

  return wrapReport(lines.join("\n"));
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a senior recruiter + ATS expert specialized in OPT/STEM OPT candidate placement. " +
  "DO NOT output reasoning. Return ONLY JSON that matches the schema. " +
  "Use ONLY the provided RESUME_ALLOWED_TEXT. " +
  "Evidence must be an EXACT SUBSTRING from RESUME_ALLOWED_TEXT or null. " +
  "Do not invent facts, durations, companies, tools, outcomes. " +
  "Preserve exact JD wording in each requirement string where applicable. " +
  "Match levels must be one of: Exact | Close | Partial | Missing. " +
  "Tool rules: variants/extensions => Close; ecosystem tool => Partial; competitors/alternatives => Missing. " +
  "Industry/regulatory terms require explicit evidence to be anything other than Missing. " +
  "Keep the output short, structured, and conservative.";

function buildDefaultUserPrompt({ job_title, job_url, job_text, starred, allowedText }) {
  return `JOB_TITLE:${job_title}
JOB_URL:${job_url}
JD_TEXT:${job_text}
STARRED_ITEMS:
${JSON.stringify(starred)}
RESUME_ALLOWED_TEXT:${allowedText}

TASK:
0) Extract experience and location requirements if present.
1) Extract only important JD skills and requirements.
2) Assign priority:
   - preferred: if matched to STARRED_ITEMS
   - must_have: if wording says must/required/minimum/mandatory
   - unspecified: otherwise
3) Compare against RESUME_ALLOWED_TEXT using strict matching.
4) Build:
   - matched_skills_top5
   - missing_must_have_skills_top5
   - missing_preferred_skills_top5
5) Build requirements_top10 with:
   { category, requirement, match_level, resume_evidence, suggestions, priority }
6) Build:
   - gaps_top6
   - improvements_top6
   - summary

OUTPUT ONLY the required schema keys.`;
}

function buildCustomUserPrompt({
  userPrompt,
  job_title,
  job_url,
  job_text,
  starred,
  allowedText,
}) {
  return `USER_CUSTOM_PROMPT:
${userPrompt}

CONTEXT:
JOB_TITLE:${job_title}
JOB_URL:${job_url}
JD_TEXT:${job_text}
STARRED_ITEMS:
${JSON.stringify(starred)}
RESUME_ALLOWED_TEXT:${allowedText}

IMPORTANT RULES:
- Use ONLY RESUME_ALLOWED_TEXT for resume evidence.
- resume_evidence must be an exact substring or null.
- Do not invent facts.
- Return ONLY valid JSON matching the schema.`;
}

export async function matchResumeToJob({
  resume_text,
  job_text,
  job_url = "",
  job_title = "",
  custom_prompt = "",
}) {
  const blocker = detectHardBlockers(job_text);

  if (blocker.blocked) {
    const report = buildBlockerReport({ blocker, job_title });

    return {
      p: 0,
      report,
      json: {
        status: "REJECTED",
        fit_score: 0,
        verdict: "BLOCKED",
        blocker_type: blocker.blocker_type,
        blocker_text: blocker.blocker_text,
        eligible_for_opt: false,
        time_worthiness: "LOW",
        tailoring_effort: "HIGH",
        decision_reasons: [
          "This role has a hard requirement you likely cannot satisfy.",
          "This application would be low-value.",
          "Prefer roles without this restriction.",
        ],
        requirements: [],
        matched_skills: [],
        missing_must_have_skills: [],
        missing_preferred_skills: [],
        experience_match: null,
        location_match: null,
        report_summary: "Blocked due to hard requirement.",
        improvements_top5: [],
      },
    };
  }

  const { allowedText } = extractAllowedResumeText(resume_text);
  const starred = extractStarredItems(job_text);
  const model = (process.env.MODEL5 || "gpt-5-mini").trim();

  const userInput =
    String(custom_prompt || "").trim()
      ? buildCustomUserPrompt({
          userPrompt: custom_prompt,
          job_title,
          job_url,
          job_text,
          starred,
          allowedText,
        })
      : buildDefaultUserPrompt({
          job_title,
          job_url,
          job_text,
          starred,
          allowedText,
        });

  const response = await client.responses.create({
    model,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userInput,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "resume_match_decision_v3",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matched_skills_top5: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
            },
            missing_must_have_skills_top5: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
            },
            missing_preferred_skills_top5: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
            },

            experience_required: { type: "string" },
            experience_candidate: { type: "string" },
            experience_match: { type: ["boolean", "null"] },

            location_required: { type: "string" },
            location_candidate: { type: "string" },
            location_match: { type: ["boolean", "null"] },

            gaps_top6: {
              type: "array",
              minItems: 0,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  gap: { type: "string" },
                  why_it_matters: { type: "string" },
                  quick_fix: { type: "string" },
                },
                required: ["gap", "why_it_matters", "quick_fix"],
              },
            },

            improvements_top6: {
              type: "array",
              minItems: 0,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  improvement: { type: "string" },
                  example_bullet: { type: "string" },
                },
                required: ["improvement", "example_bullet"],
              },
            },

            requirements_top10: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  category: { type: "string" },
                  requirement: { type: "string" },
                  match_level: {
                    type: "string",
                    enum: ["Exact", "Close", "Partial", "Missing"],
                  },
                  resume_evidence: { type: ["string", "null"] },
                  suggestions: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 3,
                  },
                  priority: {
                    type: "string",
                    enum: ["must_have", "preferred", "unspecified"],
                  },
                },
                required: [
                  "category",
                  "requirement",
                  "match_level",
                  "resume_evidence",
                  "suggestions",
                  "priority",
                ],
              },
            },

            summary: { type: "string" },
          },
          required: [
            "matched_skills_top5",
            "missing_must_have_skills_top5",
            "missing_preferred_skills_top5",
            "experience_required",
            "experience_candidate",
            "experience_match",
            "location_required",
            "location_candidate",
            "location_match",
            "gaps_top6",
            "improvements_top6",
            "requirements_top10",
            "summary",
          ],
        },
      },
    },
  });

  const raw = JSON.parse(response.output_text);
  const allowed = String(allowedText || "");

  const requirements = (raw.requirements_top10 || []).map((r) => {
    let evidence = r.resume_evidence;
    let level = r.match_level;

    if (typeof evidence === "string" && !allowed.includes(evidence)) {
      evidence = null;
      level = "Missing";
    }

    if ((level === "Exact" || level === "Close" || level === "Partial") && !evidence) {
      level = "Missing";
    }

    return {
      category: r.category,
      requirement: r.requirement,
      match_level: level,
      resume_evidence: evidence,
      suggestions: Array.isArray(r.suggestions) ? r.suggestions.slice(0, 3) : [],
      priority: r.priority || "unspecified",
    };
  });

  const matched_skills_top5 = uniq(raw.matched_skills_top5).slice(0, 5);
  const missing_must_have_skills_top5 = uniq(raw.missing_must_have_skills_top5).slice(0, 5);
  const missing_preferred_skills_top5 = uniq(raw.missing_preferred_skills_top5).slice(0, 5);

  const experience_required = String(raw.experience_required || "").trim();
  const experience_candidate = String(raw.experience_candidate || "").trim();
  const experience_match =
    typeof raw.experience_match === "boolean" ? raw.experience_match : null;

  const location_required = String(raw.location_required || "").trim();
  const location_candidate = String(raw.location_candidate || "").trim();
  const location_match =
    typeof raw.location_match === "boolean" ? raw.location_match : null;

  const gaps_top6 = Array.isArray(raw.gaps_top6) ? raw.gaps_top6.slice(0, 6) : [];
  const improvements_top6 = Array.isArray(raw.improvements_top6)
    ? raw.improvements_top6.slice(0, 6)
    : [];

  const matchScore = computeMatchScore(requirements);
  const skillsScore = computeSkillsEligibility(requirements);

  const normalized = {
    requirements,
    matched_skills: matched_skills_top5,
    missing_must_have_skills: missing_must_have_skills_top5,
    missing_preferred_skills: missing_preferred_skills_top5,
    experience_match,
    location_match,
    report_summary:
      String(raw.summary || "").trim() ||
      "Overall fit looks workable; tighten keyword alignment and make strong evidence more explicit.",
    improvements_top5: improvements_top6.slice(0, 5),
  };

  const decision = computeVerdict({
    blocked: false,
    rawScore: skillsScore.eligibility_pct || matchScore,
    missingMustHaveCount: normalized.missing_must_have_skills.length,
    missingPreferredCount: normalized.missing_preferred_skills.length,
    experienceMatch: normalized.experience_match,
    locationMatch: normalized.location_match,
  });

  const decision_reasons = buildDecisionReasons({
    matchedSkills: normalized.matched_skills,
    missingMustHaveSkills: normalized.missing_must_have_skills,
    missingPreferredSkills: normalized.missing_preferred_skills,
    experienceMatch: normalized.experience_match,
    locationMatch: normalized.location_match,
  });

  const report = buildReport({
    fitScore: decision.fit_score,
    verdict: decision.verdict,
    matchedSkills: normalized.matched_skills,
    missingMustHave: normalized.missing_must_have_skills,
    missingPreferred: normalized.missing_preferred_skills,
    summaryText: normalized.report_summary,
  });

  return {
    p: decision.fit_score,
    report,
    json: {
      status: "ELIGIBLE",
      blocker_type: null,
      blocker_text: null,
      eligible_for_opt: true,

      fit_score: decision.fit_score,
      verdict: decision.verdict,
      decision_reasons,
      time_worthiness: decision.time_worthiness,
      tailoring_effort: decision.tailoring_effort,

      match_score: matchScore,
      overall_match_score: matchScore,
      skills_score: skillsScore,

      matched_skills_top5,
      missing_must_have_skills_top5,
      missing_preferred_skills_top5,

      matched_skills: normalized.matched_skills,
      missing_must_have_skills: normalized.missing_must_have_skills,
      missing_preferred_skills: normalized.missing_preferred_skills,

      experience_required,
      experience_candidate,
      experience_match,

      location_required,
      location_candidate,
      location_match,

      gaps_top6,
      improvements_top6,
      improvements_top5: normalized.improvements_top5,

      requirements_top10: normalized.requirements,
      requirements: normalized.requirements,

      report_summary: normalized.report_summary,
      summary: normalized.report_summary,
    },
  };
}