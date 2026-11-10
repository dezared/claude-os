import { readFileSync, statSync } from 'node:fs';

const MAX_LINES = 400;
const MAX_FILE = 1024 * 1024;

export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  // One hunk over the changed range: enough for a permission card, no LCS needed.
  const ctxBefore = a.slice(Math.max(0, start - 3), start);
  const ctxAfter = a.slice(endA, endA + 3);
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const oldStart = start - ctxBefore.length + 1;
  const newStart = oldStart;
  const oldLen = ctxBefore.length + removed.length + ctxAfter.length;
  const newLen = ctxBefore.length + added.length + ctxAfter.length;
  const body = [
    ...ctxBefore.map((l) => ' ' + l),
    ...removed.map((l) => '-' + l),
    ...added.map((l) => '+' + l),
    ...ctxAfter.map((l) => ' ' + l),
  ];
  const shown = body.length > MAX_LINES ? [...body.slice(0, MAX_LINES), `... truncated, ${body.length - MAX_LINES} more lines`] : body;
  return [`--- ${path}`, `+++ ${path}`, `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...shown].join('\n');
}

function currentContent(path: string): string {
  try {
    return statSync(path).size > MAX_FILE ? '' : readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function permissionDiff(tool: string, input: Record<string, unknown>): string | null {
  const path = typeof input.file_path === 'string' ? input.file_path : null;
  if (!path) return null;
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return unifiedDiff(path, input.old_string, input.new_string);
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    return unifiedDiff(path, currentContent(path), input.content);
  }
  return null;
}
