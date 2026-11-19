// What a note says in one line, for the map, the index and the panel.
const SUMMARY_CHARS = 220;

// Frontmatter description, otherwise the first line of body that says something: headings, rules, fences and tables do not.
export function noteSummary(description: string | undefined, body: string): string | null {
  const clip = (s: string) => {
    const line = s.replace(/\s+/g, ' ').trim();
    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : line;
  };
  if (description?.trim()) return clip(description);
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !line || /^(#|---|\*\*\*|___|```|~~~|\||<!--)/.test(line)) continue;
    const text = line.replace(/^(?:[-*+]|\d+\.|>)\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a).trim();
    if (/[\p{L}\p{N}]/u.test(text)) return clip(text);
  }
  return null;
}
