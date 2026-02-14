// utils/optBlockers.js
const BLOCKER_RULES = [
  // Security clearance
  { type: "security_clearance", patterns: ["security clearance", "secret clearance", "top secret", "ts/sci", "public trust", "ssbi", "clearable", "able to obtain clearance", "dod clearance", "government clearance"] },

  // Citizenship
  { type: "citizenship_required", patterns: ["u.s. citizen", "us citizen", "united states citizen", "citizenship required", "must be a citizen", "only us citizens", "american citizen"] },

  // Permanent residency
  { type: "permanent_residency", patterns: ["green card required", "permanent resident", "lawful permanent resident", "lpr", "gc holder"] },

  // Government/federal restrictions
  { type: "government_restriction", patterns: ["federal employee", "government position", "federal agency", "dod contractor", "defense contractor", "federal contract", "government contractor"] },

  // Export control
  { type: "export_control", patterns: ["itar", "export control"] },
];

function findLineContaining(text, idx) {
  const start = Math.max(0, text.lastIndexOf("\n", idx) + 1);
  const endNl = text.indexOf("\n", idx);
  const end = endNl === -1 ? text.length : endNl;
  return text.slice(start, end).trim();
}

export function detectOptBlocker(jobText) {
  const original = String(jobText || "");
  const lower = original.toLowerCase();

  for (const rule of BLOCKER_RULES) {
    for (const phrase of rule.patterns) {
      const i = lower.indexOf(phrase.toLowerCase());
      if (i !== -1) {
        const blockerLine = findLineContaining(original, i);
        return {
          blocker_type: rule.type,
          blocker_text: blockerLine || phrase,
        };
      }
    }
  }
  return null;
}
