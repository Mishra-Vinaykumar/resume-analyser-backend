export function buildDecisionReasons({
  hardBlockerText,
  mustHaveMissing = [],
  matchedSkills = [],
  experienceMatch,
  locationMatch,
}) {
  const reasons = [];

  if (hardBlockerText) {
    reasons.push("Job contains a hard requirement you likely cannot satisfy.");
  }

  if (matchedSkills.length) {
    reasons.push(`Matched core skills: ${matchedSkills.slice(0, 3).join(", ")}.`);
  }

  if (mustHaveMissing.length) {
    reasons.push(`Missing important requirements: ${mustHaveMissing.slice(0, 3).join(", ")}.`);
  }

  if (experienceMatch === true) {
    reasons.push("Experience level appears aligned.");
  } else if (experienceMatch === false) {
    reasons.push("Experience level appears below the role requirement.");
  }

  if (locationMatch === true) {
    reasons.push("Location/work-mode appears compatible.");
  } else if (locationMatch === false) {
    reasons.push("Location/work-mode may be a mismatch.");
  }

  return reasons.slice(0, 3);
}