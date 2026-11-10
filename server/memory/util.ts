import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// `key` and `params`: what the UI shows instead of the message, errors.<key> in the web catalogs.
export function httpError(statusCode: number, message: string, key?: string, params?: Record<string, string | number>): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode, key, params });
}

let backupSeq = 0;

// Copies the current file to data/backups/<stamp>/<absolute path>. Follows symlinks: the content is what matters.
export function backupFile(dataDir: string, path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${backupSeq++}`;
  const target = join(dataDir, 'backups', stamp, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(path, target);
  return target;
}

export function wslDistro(): string {
  return process.env.WSL_DISTRO_NAME ?? 'Ubuntu-22.04';
}

export function toWslUnc(path: string): string {
  return `\\\\wsl.localhost\\${wslDistro()}${path.replaceAll('/', '\\')}`;
}

export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Top-level keys only: enough for `name` and `description`. Nested maps are collected as junk text and ignored.
export function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const raw = kv[2].trim();
    const block = /^[>|][+-]?$/.test(raw);
    const parts: string[] = block ? [] : [raw];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (block && !lines[i + 1].trim()))) parts.push(lines[++i].trim());
    data[kv[1]] = unquote(parts.join(raw.startsWith('|') ? '\n' : ' ').trim());
  }
  return { data, body: md.slice(m[0].length) };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return safely(() => String(JSON.parse(value)), value.slice(1, -1));
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

export function unifiedDiff(before: string, after: string, label = 'file'): string {
  if (before === after) return '';
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const ops = diffOps(a, b);
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let aLine = 1;
  let bLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === ' ') {
      aLine++;
      bLine++;
      i++;
      continue;
    }
    const start = Math.max(i - CONTEXT, 0);
    let end = i;
    let last = i;
    while (end < ops.length && end - last <= CONTEXT * 2) {
      if (ops[end][0] !== ' ') last = end;
      end++;
    }
    end = Math.min(last + CONTEXT + 1, ops.length);
    const hunk = ops.slice(start, end);
    const lead = i - start;
    const aCount = hunk.filter((o) => o[0] !== '+').length;
    const bCount = hunk.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${aLine - lead},${aCount} +${bLine - lead},${bCount} @@`);
    for (const [op, line] of hunk) out.push(op + line);
    for (let k = i; k < end; k++) {
      if (ops[k][0] !== '+') aLine++;
      if (ops[k][0] !== '-') bLine++;
    }
    i = end;
  }
  return out.join('\n');
}

function diffOps(a: string[], b: string[]): [string, string][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: [string, string][] = a.slice(0, head).map((l) => [' ', l]);
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const l of midA) ops.push(['-', l]);
    for (const l of midB) ops.push(['+', l]);
  } else {
    const w = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * w);
    for (let x = midA.length - 1; x >= 0; x--) {
      for (let y = midB.length - 1; y >= 0; y--) {
        lcs[x * w + y] = midA[x] === midB[y] ? lcs[(x + 1) * w + y + 1] + 1 : Math.max(lcs[(x + 1) * w + y], lcs[x * w + y + 1]);
      }
    }
    let x = 0;
    let y = 0;
    while (x < midA.length || y < midB.length) {
      if (x < midA.length && y < midB.length && midA[x] === midB[y]) {
        ops.push([' ', midA[x]]);
        x++;
        y++;
      } else if (y < midB.length && (x === midA.length || lcs[x * w + y + 1] > lcs[(x + 1) * w + y])) {
        ops.push(['+', midB[y++]]);
      } else {
        ops.push(['-', midA[x++]]);
      }
    }
  }
  for (const l of a.slice(a.length - tail)) ops.push([' ', l]);
  return ops;
}
