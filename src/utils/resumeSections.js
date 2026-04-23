// utils/resumeSections.js

const ALLOWED_SECTION_HEADERS = [
  "summary",
  "professional summary",
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "skills",
  "technical skills",
  "projects",
  "personal projects",
  "academic projects",
  "certifications",
  "education",
];

const SECTION_KEY_MAP = {
  summary: "summary",
  "professional summary": "summary",

  skills: "skills",
  "technical skills": "skills",

  experience: "experience",
  "work experience": "experience",
  "professional experience": "experience",
  employment: "experience",

  projects: "projects",
  "personal projects": "projects",
  "academic projects": "projects",

  certifications: "certifications",
  education: "education",
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HEADING_REGEX = new RegExp(
  `^\\s*(${ALLOWED_SECTION_HEADERS.map(escapeRegex).join("|")})\\s*[:\\-]?\\s*(.*)$`,
  "i"
);

export function extractAllowedResumeText(resumeText) {
  const lines = String(resumeText || "").split(/\r?\n/);

  /** @type {{summary: string[], skills: string[], experience: string[], projects: string[], certifications: string[], education: string[]}} */
  const buckets = {
    summary: [],
    skills: [],
    experience: [],
    projects: [],
    certifications: [],
    education: [],
  };

  /** @type {"summary"|"skills"|"experience"|"projects"|"certifications"|"education"|null} */
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine || "";

    const match = line.match(HEADING_REGEX);
    if (match) {
      const rawHeader = (match[1] || "").trim().toLowerCase();
      const sameLineContent = (match[2] || "").trim();

      current = SECTION_KEY_MAP[rawHeader] || null;

      if (current && sameLineContent) {
        buckets[current].push(sameLineContent);
      }
      continue;
    }

    if (current) {
      buckets[current].push(line);
    }
  }

  const hasAny = Object.values(buckets).some((arr) => arr.join("").trim());

  // fallback if no headings detected
  if (!hasAny) {
    return {
      allowedText: String(resumeText || ""),
      detectedSections: [],
    };
  }

  const detectedSections = Object.entries(buckets)
    .filter(([, value]) => value.join("").trim())
    .map(([key]) => key);

  const allowedText = [
    `SUMMARY:\n${buckets.summary.join("\n").trim()}`,
    `SKILLS:\n${buckets.skills.join("\n").trim()}`,
    `EXPERIENCE:\n${buckets.experience.join("\n").trim()}`,
    `PROJECTS:\n${buckets.projects.join("\n").trim()}`,
    `CERTIFICATIONS:\n${buckets.certifications.join("\n").trim()}`,
    `EDUCATION:\n${buckets.education.join("\n").trim()}`,
  ]
    .filter((section) => !section.endsWith(":\n"))
    .join("\n\n");

  return {
    allowedText,
    detectedSections,
  };
}