// utils/resumeSections.js
const HEADINGS = [
  { key: "summary", re: /^\s*(professional\s+summary|summary)\s*[:\-]?\s*(.*)$/i },
  { key: "skills", re: /^\s*(technical\s+skills|skills)\s*[:\-]?\s*(.*)$/i },
  { key: "experience", re: /^\s*(work\s+experience|professional\s+experience|experience)\s*[:\-]?\s*(.*)$/i },
];

export function extractAllowedResumeText(resumeText) {
  const lines = String(resumeText || "").split(/\r?\n/);

  /** @type {{summary: string[], skills: string[], experience: string[]}} */
  const buckets = { summary: [], skills: [], experience: [] };

  /** @type {"summary"|"skills"|"experience"|null} */
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine || "";

    let switched = false;
    for (const h of HEADINGS) {
      const m = line.match(h.re);
      if (m) {
        current = h.key;
        const sameLineContent = (m[2] || "").trim();
        if (sameLineContent) buckets[current].push(sameLineContent);
        switched = true;
        break;
      }
    }
    if (switched) continue;

    if (current) buckets[current].push(line);
  }

  const hasAny =
    buckets.summary.join("").trim() || buckets.skills.join("").trim() || buckets.experience.join("").trim();

  // If headings weren’t detectable, safest fallback is: pass the whole resume,
  // but label it so your prompt still enforces “use only provided text”.
  if (!hasAny) {
    return {
      allowedText: String(resumeText || ""),
      detectedSections: [],
    };
  }

  const detectedSections = Object.entries(buckets)
    .filter(([, v]) => v.join("").trim())
    .map(([k]) => k);

  const allowedText =
    `SUMMARY:\n${buckets.summary.join("\n").trim()}\n\n` +
    `SKILLS:\n${buckets.skills.join("\n").trim()}\n\n` +
    `EXPERIENCE:\n${buckets.experience.join("\n").trim()}\n`;

  return { allowedText, detectedSections };
}
