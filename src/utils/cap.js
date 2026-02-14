export function cap(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "\n...[TRIMMED]...";
}
