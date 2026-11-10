// Unified diff text to rows. Pure: the panel only renders.
export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null; }
export interface DiffHunk { header: string; lines: DiffLine[]; }

export function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    // "\ No newline at end of file" and the trailing empty split are not rows.
  }
  return hunks;
}

export interface SplitRow { left: DiffLine | null; right: DiffLine | null; }

// Removed and added runs face each other; context sits on both sides.
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'ctx') {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
