/** claude-opus-5-5-20261101 -> Opus 5.5. Anything else stays as it is. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?(?:\[.*\])?$/.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
