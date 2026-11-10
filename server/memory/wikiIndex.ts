import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generated wiki files: projects/<key>/MEMORY.md (loaded by Claude Code), _index/<key>.md (full catalog), _log/<key>.md (audit trail).

export interface IndexNote {
  name: string;
  file: string;
  description: string | null;
  summary: string | null;
  type: string | null;
  tags: string[];
  // metadata.modified, else the file mtime (ms).
  recency: number;
}

export const MEMORY_BUDGET = { lines: 100, bytes: 10_000 };

const TYPES = ['user', 'feedback', 'project', 'reference'];
const HOOK_MAX = 120;
const LOG_MAX = 500;

const typeOf = (n: IndexNote) => (n.type && TYPES.includes(n.type) ? n.type : 'project');
const byName = (a: IndexNote, b: IndexNote) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

function hook(n: IndexNote): string {
  const text = (n.description || n.summary || '').replace(/\s+/g, ' ').trim();
  return text.length > HOOK_MAX ? `${text.slice(0, HOOK_MAX - 1)}…` : text;
}

// One `## <type>` group per present type, in type order, names sorted inside.
function grouped(notes: IndexNote[], line: (n: IndexNote) => string): string[] {
  const out: string[] = [];
  for (const type of TYPES) {
    const group = notes.filter((n) => typeOf(n) === type).sort(byName);
    if (group.length) out.push(`## ${type}`, ...group.map(line));
  }
  return out;
}

export function renderMemoryIndex(key: string, notes: IndexNote[]): string {
  const line = (n: IndexNote) => {
    const h = hook(n);
    return h ? `- [${n.name}](${n.file}) — ${h}` : `- [${n.name}](${n.file})`;
  };
  const ranked = [...notes].sort((a, b) => TYPES.indexOf(typeOf(a)) - TYPES.indexOf(typeOf(b)) || b.recency - a.recency || byName(a, b));
  const render = (k: number) => {
    const lines = grouped(ranked.slice(0, k), line);
    if (k < ranked.length) lines.push(`+${ranked.length - k} more: _index/${key}.md, or memory_search`);
    return { text: lines.length ? `${lines.join('\n')}\n` : '', count: lines.length };
  };
  const fits = (r: { text: string; count: number }) => r.count <= MEMORY_BUDGET.lines && Buffer.byteLength(r.text) <= MEMORY_BUDGET.bytes;
  let best = render(0);
  for (let k = 1; k <= ranked.length; k++) {
    const next = render(k);
    if (!fits(next)) break;
    best = next;
  }
  return best.text;
}

export function renderCatalog(key: string, notes: IndexNote[]): string {
  const stem = (file: string) => file.replace(/\.md$/, '');
  const line = (n: IndexNote) => {
    const h = hook(n);
    return [`- [[projects/${key}/${stem(n.file)}|${n.name}]]`, ...(h ? ['—', h] : []), ...n.tags.map((t) => `#${t}`)].join(' ');
  };
  return `${[`# ${key}`, ...grouped(notes, line)].join('\n')}\n`;
}

export function appendLog(
  vault: string,
  key: string,
  entries: { op: 'add' | 'update' | 'delete' | 'fix' | 'migrate'; name: string; reason?: string }[],
  now = new Date(),
): void {
  if (!entries.length) return;
  const pad = (v: number) => String(v).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dir = join(vault, '_log');
  const path = join(dir, `${key}.md`);
  const old = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : [];
  const added = entries.map((e) => {
    const reason = e.reason?.replace(/\s+/g, ' ').trim();
    return `${day} ${e.op} ${e.name}${reason ? ` ${reason}` : ''}`;
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${[...old, ...added].slice(-LOG_MAX).join('\n')}\n`);
}
