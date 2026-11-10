import { parseFrontmatter } from './util.ts';

// `-` and `_` count as one character: both spellings of the same name occur in real notes.
export function normalizeName(name: string): string {
  const base = name.trim().replace(/\\+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.md$/i, '').toLowerCase().replaceAll('_', '-');
}

// Links inside code are examples, not links.
export function extractLinks(markdown: string): string[] {
  const text = parseFrontmatter(markdown).body
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const found = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    const name = normalizeName(m[1]);
    if (name) found.add(name);
  }
  return [...found];
}

export interface LinkNote { dir: string | null; vaultKey: string | null; isGlobal: boolean; project: string | null }

// The note a [[name]] in `from` opens: its own folder first, then its project, then global/, then a name unique everywhere.
export function resolveLinkIn<T extends LinkNote>(byName: Map<string, T[]>, from: LinkNote, name: string): T | null {
  const candidates = byName.get(name);
  if (!candidates) return null;
  return candidates.find((c) => c.dir === from.dir && c.vaultKey === from.vaultKey && c.isGlobal === from.isGlobal)
    ?? candidates.find((c) => from.project !== null && c.project === from.project)
    ?? candidates.find((c) => c.isGlobal)
    ?? (candidates.length === 1 ? candidates[0] : null);
}
