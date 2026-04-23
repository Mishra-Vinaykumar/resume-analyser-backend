export function computeVerdict({
  hardBlocker = false,
  mustHaveMatched = 0,
  mustHaveMissing = 0,
  preferredMatched = 0,
  experienceMatch = null,
  locationMatch = null,
  rawScore = 0,
}) {
  if (hardBlocker) {
    return {
      fit_score: 0,
      verdict: "BLOCKED",
      time_worthiness: "LOW",
      tailoring_effort: "HIGH",
    };
  }

  let score = Number(rawScore) || 0;

  score += mustHaveMatched * 6;
  score -= mustHaveMissing * 8;
  score += preferredMatched * 2;

  if (experienceMatch === true) score += 8;
  if (experienceMatch === false) score -= 10;

  if (locationMatch === true) score += 3;
  if (locationMatch === false) score -= 5;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = "SKIP";
  if (score >= 85) verdict = "APPLY_NOW";
  else if (score >= 70) verdict = "APPLY_WITH_TAILORING";
  else if (score >= 55) verdict = "STRETCH_APPLY";
  else verdict = "SKIP";

  let time_worthiness = "LOW";
  if (verdict === "APPLY_NOW") time_worthiness = "HIGH";
  else if (verdict === "APPLY_WITH_TAILORING") time_worthiness = "MEDIUM";
  else if (verdict === "STRETCH_APPLY") time_worthiness = "MEDIUM";

  let tailoring_effort = "HIGH";
  if (mustHaveMissing === 0) tailoring_effort = "LOW";
  else if (mustHaveMissing <= 2) tailoring_effort = "MEDIUM";

  return {
    fit_score: score,
    verdict,
    time_worthiness,
    tailoring_effort,
  };
}