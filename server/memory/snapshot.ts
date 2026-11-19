// The scanned note files kept on disk between runs (data/memory-snapshot.ndjson): a start loads them and rereads
// only the files whose mtime or size moved, instead of reading every note of a 100k-note vault again.
// One JSON line per note after a header line; written to a temp file and renamed, so a crash leaves the old one.
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bodyOf } from './frontmatter.ts';
import type { NoteFile, Places } from './scan.ts';

// Bump when NoteFile or how it is derived changes: an old snapshot is then ignored and the vault read again.
const VERSION = 1;
const FORMAT = 'claude-os-memory-snapshot';
const CHUNK = 1 << 20;
const WRITE_SLICE_MS = 10;

const header = (places: Places) => JSON.stringify({ format: FORMAT, version: VERSION, vault: places.vault, claudeProjects: places.claudeProjects });

// The body is the content's own tail: it is cut again on load rather than stored twice.
const line = (n: NoteFile) => JSON.stringify({ ...n, meta: { ...n.meta, body: undefined } });

function parsed(text: string): NoteFile {
  const n = JSON.parse(text) as NoteFile;
  const ok = typeof n.path === 'string' && typeof n.content === 'string' && typeof n.sha === 'string' && typeof n.id === 'string'
    && typeof n.mtime === 'number' && typeof n.size === 'number' && Array.isArray(n.links) && typeof n.meta === 'object' && n.meta !== null;
  if (!ok) throw new Error('memory snapshot: malformed note line');
  n.meta.body = bodyOf(n.content);
  return n;
}

// The lines of a file, read 1 MB at a time.
function* lines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let rest = Buffer.alloc(0);
    for (let got = readSync(fd, buf, 0, CHUNK, null); got > 0; got = readSync(fd, buf, 0, CHUNK, null)) {
      const data = Buffer.concat([rest, buf.subarray(0, got)]);
      let start = 0;
      for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
        yield data.toString('utf8', start, end);
        start = end + 1;
      }
      rest = data.subarray(start);
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// One note per step. Throws on a missing, foreign, old or malformed snapshot: the caller reads the vault instead.
export function* readSnapshot(path: string, places: Places): Generator<void, Map<string, NoteFile>> {
  const files = new Map<string, NoteFile>();
  let first = true;
  for (const text of lines(path)) {
    if (first) {
      if (text !== header(places)) throw new Error('memory snapshot: other version or places');
      first = false;
      continue;
    }
    const n = parsed(text);
    files.set(n.path, n);
    yield;
  }
  if (first) throw new Error('memory snapshot: empty');
  return files;
}

// Serializes in short slices between requests; `stop` abandons the write (the server is closing).
export async function writeSnapshot(path: string, places: Places, files: Iterable<NoteFile>, stop: () => boolean): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    let chunk = [header(places)];
    let until = performance.now() + WRITE_SLICE_MS;
    for (const n of files) {
      chunk.push(line(n));
      if (performance.now() < until) continue;
      await fh.write(`${chunk.join('\n')}\n`);
      if (stop()) return false;
      chunk = [];
      until = performance.now() + WRITE_SLICE_MS;
    }
    await fh.write(chunk.length ? `${chunk.join('\n')}\n` : '');
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  return true;
}
