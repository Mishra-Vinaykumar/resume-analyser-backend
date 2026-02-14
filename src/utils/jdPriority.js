export function extractStarredItems(jobText = "") {
  const lines = String(jobText).split("\n").map(l => l.trim());
  const starred = [];
  for (const l of lines) {
    // matches: "* Python", "• * Python", "- * Python"
    if (/^(?:[-•]\s*)?\*\s+/.test(l)) {
      starred.push(l.replace(/^(?:[-•]\s*)?\*\s+/, "").trim());
    }
  }
  // dedupe
  return Array.from(new Set(starred)).filter(Boolean);
}
