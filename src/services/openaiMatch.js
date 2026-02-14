import OpenAI from "openai";
import { extractAllowedResumeText } from "../utils/resumeSections.js";
import { extractStarredItems } from "../utils/jdPriority.js";
import { detectOptBlocker } from "../utils/optBlockers.js"; // ✅ keep Step 0 blockers (if you already do it in route, you can remove)

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TIER_POINTS = { Exact: 1.0, Close: 0.8, Partial: 0.5, Missing: 0.0 };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uniq(arr) {
  const out = [];
  const s = new Set();
  for (const x of arr || []) {
    const k = String(x || "").trim();
    if (!k || s.has(k)) continue;
    s.add(k);
    out.push(k);
  }
  return out;
}

function computeMatchScore(requirements) {
  const items = Array.isArray(requirements) ? requirements : [];
  if (!items.length) return 0;

  const sum = items.reduce((acc, r) => acc + (TIER_POINTS[r?.match_level] ?? 0), 0);
  return Math.round((sum / items.length) * 1000) / 10; // 1 decimal
}

function recommendationFromScore(score) {
  if (score >= 80) return "APPLY";
  if (score >= 65) return "APPLY_WITH_ADJUSTMENTS";
  return "BORDERLINE";
}

function wrapReport(body) {
  return `REPORT (conversational analysis):\n"""\n${body}\n"""`;
}

function isHighImpactCategory(category) {
  const c = String(category || "").toLowerCase();
  return (
    c.includes("tools") ||
    c.includes("domain") ||
    c.includes("industry") ||
    c.includes("regulatory") ||
    c.includes("compliance") ||
    c.includes("outcomes") ||
    c.includes("impact")
  );
}

function categoryRank(category) {
  const c = String(category || "").toLowerCase();
  if (c.includes("tools")) return 1;
  if (c.includes("domain") || c.includes("industry")) return 2;
  if (c.includes("regulatory") || c.includes("compliance")) return 3;
  if (c.includes("outcomes") || c.includes("impact")) return 4;
  return 5;
}

function matchLevelRank(level) {
  if (level === "Missing") return 1;
  if (level === "Partial") return 2;
  if (level === "Close") return 3;
  return 4; // Exact
}

function isKeyCloseOrPartial(r) {
  const c = String(r.category || "").toLowerCase();
  const isTools = c.includes("tools");
  const isReg = c.includes("regulatory") || c.includes("compliance");
  const isDomain = c.includes("domain") || c.includes("industry");
  return (isTools || isReg || isDomain) && (r.match_level === "Close" || r.match_level === "Partial");
}

function buildReport({ matchScore, gaps, closeMatches, summaryText }) {
  const lines = [];
  lines.push("✅ OPT/STEM OPT ELIGIBLE - No critical blockers detected");
  lines.push("");
  lines.push(`Match Score: ${matchScore.toFixed(1)}%`);
  lines.push("");
  lines.push("HIGH-IMPACT GAPS:");
  lines.push("");

  if (!gaps.length) {
    lines.push("(No high-impact gaps detected based on current filtering.)");
    lines.push("");
  } else {
    const sorted = [...gaps].sort((a, b) => {
      const cr = categoryRank(a.category) - categoryRank(b.category);
      if (cr !== 0) return cr;
      const mr = matchLevelRank(a.match_level) - matchLevelRank(b.match_level);
      if (mr !== 0) return mr;
      return String(a.requirement).localeCompare(String(b.requirement));
    });

    const byCat = new Map();
    for (const g of sorted) {
      const cat = g.category || "Other";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(g);
    }

    for (const [cat, items] of byCat.entries()) {
      lines.push(`${cat}:`);
      for (const it of items) {
        lines.push(`- ${it.requirement}: ${it.match_level}`);
        lines.push(`  Resume evidence: ${it.resume_evidence || "Not found"}`);
        if (Array.isArray(it.suggestions) && it.suggestions.length) {
          lines.push("  Suggestions:");
          for (const s of it.suggestions.slice(0, 3)) lines.push(`  - ${s}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("CLOSE MATCHES WORTH NOTING:");
  if (!closeMatches.length) {
    lines.push("- (None worth noting based on current filtering.)");
  } else {
    const sortedClose = [...closeMatches].sort((a, b) => {
      const cr = categoryRank(a.category) - categoryRank(b.category);
      if (cr !== 0) return cr;
      const mr = matchLevelRank(a.match_level) - matchLevelRank(b.match_level);
      if (mr !== 0) return mr;
      return String(a.requirement).localeCompare(String(b.requirement));
    });

    for (const it of sortedClose) lines.push(`- ${it.requirement} (${it.match_level})`);
  }

  lines.push("");
  lines.push("SUMMARY:");
  lines.push(summaryText);

  return wrapReport(lines.join("\n"));
}

function buildBlockerReport({ blocker, job_title }) {
  const position = job_title || "Not provided";
  const company = "Not provided";

  const body =
    `🚫 APPLICATION REJECTED - CRITICAL BLOCKER DETECTED

Position: ${position}
Company: ${company}

BLOCKER IDENTIFIED:
- ${blocker.blocker_text}

REASON FOR REJECTION:
This position requires government authorization (clearance/citizenship/permanent residency/export control) which is NOT available to OPT/STEM OPT candidates on F-1 visa status.

OPT/F-1 visa holders CANNOT:
- Obtain security clearances (any level)
- Meet U.S. citizenship requirements
- Work on federal government contracts requiring citizenship
- Comply with ITAR/export control restrictions
- Meet "green card required" stipulations

RECOMMENDATION: ⛔ DO NOT APPLY - Skip this position entirely

---
Would you like me to analyze a different job posting?`;

  return body;
}

export async function matchResumeToJob({ resume_text, job_text, job_url = "", job_title = "" }) {
  // ✅ STEP 0: Blocker detection (token-free)
  const blocker = detectOptBlocker(job_text);
  if (blocker) {
    const report = buildBlockerReport({ blocker, job_title });
    return {
      p: 0,
      report,
      json: {
        status: "REJECTED",
        blocker_type: blocker.blocker_type,
        blocker_text: blocker.blocker_text,
        match_score: null,
        eligible_for_opt: false,
        recommendation: "DO_NOT_APPLY",
        reason: "Position contains a critical OPT/F-1 blocker (clearance/citizenship/permanent residency/government/export control)."
      }
    };
  }

  // Resume section restriction (Skills/Summary/Experience only)
  const { allowedText } = extractAllowedResumeText(resume_text);
  const starred = extractStarredItems(job_text);

  const model = (process.env.MODEL5 || "gpt-5-mini").trim();

  const response = await client.responses.create({
    model,
    reasoning: { effort: "low" },
    input: [
      // OLD SYSTEM PROMPT
      // {
      //   role: "system",
      //   content:
      //     "You are a senior recruiter + ATS expert specialized in OPT/STEM OPT candidate placement. " +
      //     "DO NOT output reasoning. Return ONLY JSON that matches the schema. " +
      //     "Use ONLY the provided RESUME_ALLOWED_TEXT (Skills/Summary/Experience). Ignore projects/certifications even if present elsewhere. " +
      //     "Evidence must be an EXACT SUBSTRING from RESUME_ALLOWED_TEXT or null. " +
      //     "Do not invent facts, durations, companies, tools, outcomes. " +
      //     "Preserve exact JD wording in each requirement string (copy exact phrases). " +
      //     "Match levels must be one of: Exact | Close | Partial | Missing. " +
      //     "Tool rules: variants/extensions => Close; ecosystem tool => Partial; competitors/alternatives => Missing (AWS≠Azure/GCP, React≠Angular/Vue, MongoDB≠PostgreSQL, etc). " +
      //     "Industry/regulatory terms require explicit evidence (substring) to be anything other than Missing. " +
      //     "Max 3 suggestions per gap; keep them conservative and role-credible. " +
      //     "Return SHORT output only (top skills + max 10 requirement items)."
      // },
      // NEW SYSTEM PROMPT
      {
        role: "system",
        content:
          "You are a senior recruiter + ATS expert specialized in OPT/STEM OPT candidate placement. " +
          "DO NOT output reasoning. Return ONLY JSON that matches the schema. " +
          "Use ONLY the provided RESUME_ALLOWED_TEXT (Skills/Summary/Experience). Ignore projects/certifications even if present elsewhere. " +
          "Evidence must be an EXACT SUBSTRING from RESUME_ALLOWED_TEXT or null. " +
          "Do not invent facts, durations, companies, tools, outcomes. " +
          "Preserve exact JD wording in each requirement string (copy exact phrases). " +
          "Match levels must be one of: Exact | Close | Partial | Missing. " +
          "Tool rules: variants/extensions => Close; ecosystem tool => Partial; competitors/alternatives => Missing (AWS≠Azure/GCP, React≠Angular/Vue, MongoDB≠PostgreSQL, etc). " +
          "Industry/regulatory terms require explicit evidence (substring) to be anything other than Missing. " +
          "Max 3 suggestions per requirement; keep them conservative and role-credible. " +
          "For Exact matches, suggestions must be an empty array []. " +
          "Return SHORT output only (top skills + max 10 requirement items). " +
          "Also extract years-of-experience and location requirement if present, then compare with resume (strict). " +
          "Output must contain ONLY these top-level keys: matched_skills_top5, missing_must_have_skills_top5, missing_preferred_skills_top5, experience_required, experience_candidate, experience_match, location_required, location_candidate, location_match, gaps_top6, improvements_top5, requirements_top10, summary."

      },
      // UserPrompt with FullAnalyise
      // {
      //   role: "user",
      //   content:
      //     `JOB_TITLE:\n${job_title}\n\n` +
      //     `JOB_URL:\n${job_url}\n\n` +
      //     `JD_TEXT:\n${job_text}\n\n` +
      //     `STARRED_ITEMS (preferred key skills marked with "*"):\n${JSON.stringify(starred)}\n\n` +
      //     `RESUME_ALLOWED_TEXT:\n${allowedText}\n\n` +
      //     "TASK:\n" +
      //     "1) Extract JD requirements across ONLY these categories: Skills; Tools & Technologies; Relevant Experiences; Domain/Industry Knowledge; Regulatory/Compliance Requirements; Years of Experience; Measurable Outcomes / Impact.\n" +
      //     "2) Normalize/cluster ONLY conceptual synonyms (example: client management ≈ customer success). Keep named tools/platforms and regulatory terms UNCLUSTERED and exact.\n" +
      //     "3) For EACH extracted requirement, output:\n" +
      //     "   - category\n" +
      //     "   - requirement (MUST preserve exact JD wording)\n" +
      //     "   - match_level (Exact | Close | Partial | Missing)\n" +
      //     "   - resume_evidence (MUST be an exact substring from RESUME_ALLOWED_TEXT or null)\n" +
      //     "   - suggestions (ONLY if match_level is Missing/Partial/Close; max 3; conservative; do not invent facts/tools/durations)\n" +
      //     "   - priority (must_have | preferred | unspecified)\n" +
      //     "4) PRIORITY RULES:\n" +
      //     "   - If the requirement text matches any STARRED_ITEMS entry (case-insensitive), set priority='preferred'.\n" +
      //     "   - If JD wording indicates required (e.g., 'must', 'required', 'minimum', 'need to'), set priority='must_have'.\n" +
      //     "   - Otherwise set priority='unspecified'.\n" +
      //     "5) Provide a 2–3 sentence summary of overall fit and key actions to improve alignment.\n"
      // }

      {
        role: "user",
        content: `JOB_TITLE:${job_title}
        JOB_URL:${job_url}
        JD_TEXT:${job_text}
        STARRED_ITEMS (preferred key skills marked with "*"):
        ${JSON.stringify(starred)}
        RESUME_ALLOWED_TEXT:${allowedText}

      TASK (TOKEN-LIGHT, GAP-FIRST OUTPUT):
      0) Experience & Location extraction:
         - If JD mentions years (e.g. "2+ years", "3-5 years"), set experience_required EXACT JD text.
         - From RESUME_ALLOWED_TEXT, extract candidate years/duration if present (short). If not found, empty string.
         - Set experience_match true only if candidate clearly meets/exceeds required; else false.
         - Extract JD location requirement (Remote/Hybrid/Onsite + city/state if present) into location_required.
         - Extract candidate location from RESUME_ALLOWED_TEXT if present; else empty string.
         - Set location_match true only if clearly compatible; else false.

      1) Extract ONLY JD SKILLS (named tools + skills) that are important for the role. Keep wording EXACT from the JD for each extracted skill/requirement.

      2) Assign priority for each JD skill:
         - preferred: if the skill text matches any STARRED_ITEMS entry (case-insensitive)
         - must_have: if the JD wording indicates required (must, required, minimum, need, mandatory)
         - unspecified: otherwise

      3) Compare each JD skill against RESUME_ALLOWED_TEXT using strict matching:
         match_level = Exact | Close | Partial | Missing
         resume_evidence MUST be an exact substring from RESUME_ALLOWED_TEXT or null.

      4) Build lists (dedupe, most important first):
         - matched_skills_top5: top 5 JD skills with match_level in (Exact/Close/Partial)
         - missing_must_have_skills_top5: top 5 Missing skills with priority = must_have
         - missing_preferred_skills_top5: top 5 Missing skills with priority = preferred

      5) Build requirements_top10 (MAX 10 items) with:
         { category, requirement, match_level, resume_evidence, suggestions, priority }
         CATEGORY RULES:
         - Use category = "Tools & Technologies" when it is a named tool/platform/language/framework
         - Else category = "Skills"
         REQUIREMENTS_TOP10 MUST be GAP-FIRST in this order:
         A) Missing + must_have first
         B) Missing + preferred next
         C) Missing + unspecified next
         D) Then Close/Partial must_have/preferred if space remains
         Each item MUST include suggestions ONLY when match_level is Missing/Close/Partial (max 3).

      6) Create:
         - gaps_top6: top 6 high-impact missing items (prefer Tools & Technologies first, then Skills)
         - improvements_top6: top 6 short actionable suggestions (<= 10 words each), deduped
         - summary: 2–3 sentences max

      OUTPUT ONLY these keys and nothing else:
      matched_skills_top5
      missing_must_have_skills_top5
      missing_preferred_skills_top5
      experience_required
      experience_candidate
      experience_match
      location_required
      location_candidate
      location_match
      gaps_top6
      improvements_top6
      requirements_top10
      summary`
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "opt_match_light_v2",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matched_skills_top5: { type: "array", items: { type: "string" }, maxItems: 5 },
            missing_must_have_skills_top5: { type: "array", items: { type: "string" }, maxItems: 5 },
            missing_preferred_skills_top5: { type: "array", items: { type: "string" }, maxItems: 5 },

            experience_required: { type: "string" },     // e.g. "3+ years"
            experience_candidate: { type: "string" },    // short text, can be ""
            experience_match: { type: "boolean" },

            location_required: { type: "string" },       // e.g. "Bengaluru / Hybrid"
            location_candidate: { type: "string" },      // short text, can be ""
            location_match: { type: "boolean" },

            gaps_top6: {
              type: "array",
              minItems: 0,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  gap: { type: "string" },
                  why_it_matters: { type: "string" },
                  quick_fix: { type: "string" }
                },
                required: ["gap","why_it_matters","quick_fix"],
                additionalProperties: false
              }
            },

            improvements_top6: {
              type: "array",
              minItems: 0,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  improvement: { type: "string" },
                  example_bullet: { type: "string" }
                },
                required: ["improvement", "example_bullet"],
                additionalProperties: false
              }
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
                  match_level: { type: "string", enum: ["Exact", "Close", "Partial", "Missing"] },
                  resume_evidence: { type: ["string", "null"] },
                  suggestions: { type: "array", items: { type: "string" }, maxItems: 3 },
                  priority: { type: "string", enum: ["must_have", "preferred", "unspecified"] }
                },
                required: ["category", "requirement", "match_level", "resume_evidence", "suggestions", "priority"]
              }
            },

            summary: { type: "string" }
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
            "summary"
          ]
        }
      }
    }
  });

  const raw = JSON.parse(response.output_text);

  // Post-validate evidence is an exact substring (hard guardrail)
  const allowed = String(allowedText || "");
  const requirements = (raw.requirements_top10 || []).map((r) => {
    let evidence = r.resume_evidence;
    let level = r.match_level;

    if (typeof evidence === "string") {
      if (!allowed.includes(evidence)) {
        evidence = null;
        level = "Missing";
      }
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
      priority: r.priority || "unspecified"
    };
  });

  const matchScore = computeMatchScore(requirements);
  const rec = recommendationFromScore(matchScore);

  // Minimum report threshold:
  const gaps = requirements.filter((r) => {
    if (!isHighImpactCategory(r.category)) return false;
    if (r.match_level === "Missing") return true;
    return isKeyCloseOrPartial(r);
  });

  const closeMatches = requirements.filter((r) => isKeyCloseOrPartial(r));

  const summaryText =
    String(raw.summary || "").trim() ||
    "Overall fit looks workable; tighten keyword alignment and ensure every claimed match has explicit resume evidence.";

  const report = buildReport({
    matchScore,
    gaps,
    closeMatches,
    summaryText
  });

  // ✅ Ensure these are max 5 and deduped
  const matched_skills_top5 = uniq(raw.matched_skills_top5).slice(0, 5);
  const missing_must_have_skills_top5 = uniq(raw.missing_must_have_skills_top5).slice(0, 5);
  const missing_preferred_skills_top5 = uniq(raw.missing_preferred_skills_top5).slice(0, 5);

  // ✅ NEW: Experience/Location + Top6 blocks (safe defaults)
  const experience_required = String(raw.experience_required || "").trim();
  const experience_candidate = String(raw.experience_candidate || "").trim();
  const experience_match = !!raw.experience_match;

  const location_required = String(raw.location_required || "").trim();
  const location_candidate = String(raw.location_candidate || "").trim();
  const location_match = !!raw.location_match;

  const gaps_top6 = Array.isArray(raw.gaps_top6) ? raw.gaps_top6.slice(0, 6) : [];
  const improvements_top6 = Array.isArray(raw.improvements_top6) ? raw.improvements_top6.slice(0, 6) : [];

  // ✅ Backward compatible keys (so frontend won't break)
  const matched_skills = matched_skills_top5;
  const missing_must_have_skills = missing_must_have_skills_top5;
  const missing_preferred_skills = missing_preferred_skills_top5;

  return {
    p: clamp(Math.round(matchScore), 0, 100),
    report,
    json: {
      status: "ELIGIBLE",
      blocker_type: null,
      blocker_text: null,
      eligible_for_opt: true,
      match_score: matchScore,
      recommendation: rec,

      // ✅ NEW (top5)
      matched_skills_top5,
      missing_must_have_skills_top5,
      missing_preferred_skills_top5,

      // ✅ Experience + Location match
      experience_required,
      experience_candidate,
      experience_match,

      location_required,
      location_candidate,
      location_match,

      // ✅ Top6 token-light lists
      gaps_top6,
      improvements_top6,

      // ✅ OLD (compat)
      matched_skills,
      missing_must_have_skills,
      missing_preferred_skills,

      // ✅ small list only
      requirements_top10: requirements,
      summary: summaryText
    }
  };
}
