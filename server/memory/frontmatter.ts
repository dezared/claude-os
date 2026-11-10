// Note frontmatter without a YAML library: top-level keys, one nested map level, inline `[a, b]` and block `- a` lists,
// quoted and block scalars. Enough for Claude Code's `{ name, description, metadata }` shape.

export type FmMap = { [k: string]: string | string[] };
export type FmValue = string | string[] | FmMap;
export type Frontmatter = Record<string, FmValue>;

export type NoteMeta = {
  name: string | null;
  description: string | null;
  type: string | null;
  tags: string[];
  modified: number | null;
  body: string;
  hasFrontmatter: boolean;
};

const FM = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY = /^([\w-]+):(?:[ \t]+(.*))?$/;

export const isMap = (v: FmValue | undefined): v is FmMap => typeof v === 'object' && !Array.isArray(v);

export function parseNote(md: string): { fm: Frontmatter | null; body: string } {
  const m = FM.exec(md);
  if (!m) return { fm: null, body: md };
  return { fm: parseBlock((m[1] ?? '').split(/\r?\n/), true), body: md.slice(m[0].length) };
}

function parseBlock(lines: string[], nest: boolean): Frontmatter {
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const kv = KEY.exec(lines[i++]);
    if (!kv || kv[1] === '__proto__') continue;
    const raw = (kv[2] ?? '').trim();
    const child: string[] = [];
    // A block list may sit at the key's own indent (`tags:\n- a`).
    while (i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim() || (!raw && /^-(\s|$)/.test(lines[i])))) child.push(lines[i++]);
    while (child.length && !child[child.length - 1].trim()) child.pop();
    out[kv[1]] = parseValue(raw, child, nest);
  }
  return out;
}

function parseValue(raw: string, child: string[], nest: boolean): FmValue {
  if (/^[|>][+-]?\d*$/.test(raw)) {
    const indent = Math.min(...child.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    const lines = child.map((l) => l.slice(indent).trimEnd());
    return (raw.startsWith('|') ? lines.join('\n') : lines.map((l) => l || '\n').join(' ').replace(/ ?\n ?/g, '\n')).trim();
  }
  const filled = child.filter((l) => l.trim());
  if (!raw && filled.length) {
    if (/^\s*-(\s|$)/.test(filled[0])) return filled.map((l) => unquote(l.trim().replace(/^-\s*/, '')));
    if (nest && KEY.test(filled[0].trim())) {
      const indent = /^\s*/.exec(filled[0])![0].length;
      const nested = parseBlock(child.map((l) => l.slice(indent)), false);
      return Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, isMap(v) ? '' : v]));
    }
  }
  const text = [raw, ...filled.map((l) => l.trim())].filter(Boolean).join(' ');
  return text.startsWith('[') && text.endsWith(']') ? inlineList(text.slice(1, -1)) : unquote(text);
}

function inlineList(inner: string): string[] {
  const items: string[] = [];
  for (const m of inner.matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]*?)\s*(?:,|$)/g)) {
    if (m[1]) items.push(unquote(m[1]));
    if (m.index + m[0].length >= inner.length) break;
  }
  return items;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

const TOP = ['name', 'description', 'metadata'];
const META_FIRST = ['type', 'tags'];

// Quoted with JSON.stringify (valid YAML) whenever a plain scalar would be misread.
function scalar(v: string, inList = false): string {
  const risky = v === '' || /: | #|[\r\n\t]|:$/.test(v) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) || v !== v.trim() || (inList && /[,[\]{}]/.test(v));
  return risky ? JSON.stringify(v) : v;
}

function value(v: string | string[]): string {
  return Array.isArray(v) ? `[${v.map((x) => scalar(x, true)).join(', ')}]` : scalar(v);
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = ['---'];
  const keys = [...TOP.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !TOP.includes(k))];
  for (const key of keys) {
    const v = fm[key];
    if (!isMap(v)) {
      lines.push(`${key}: ${value(v)}`);
      continue;
    }
    const sub = key === 'metadata' ? [...META_FIRST.filter((k) => k in v), ...Object.keys(v).filter((k) => !META_FIRST.includes(k))] : Object.keys(v);
    if (!sub.length) continue;
    lines.push(`${key}:`);
    for (const k of sub) lines.push(`  ${k}: ${value(v[k])}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

const str = (v: FmValue | undefined): string | null => (typeof v === 'string' ? v : null);

function listOf(v: FmValue | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function stamp(v: string | null): number | null {
  if (!v) return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

export function noteMeta(md: string): NoteMeta {
  const { fm, body } = parseNote(md);
  const meta = fm && isMap(fm.metadata) ? fm.metadata : {};
  return {
    name: str(fm?.name),
    description: str(fm?.description),
    type: str(meta.type) ?? str(fm?.type),
    tags: listOf(meta.tags ?? fm?.tags),
    modified: stamp(str(meta.modified)),
    body,
    hasFrontmatter: fm !== null,
  };
}
