// Note vectors in memory, int8 with a scale per note: 388 bytes a note, under 40 MB at 100k notes. A search reads them all
// (brute force), which at 100k notes is faster than one FTS query with several words.
import { nextTurn } from '../turns.ts';

export interface VectorMeta {
  path: string;
  sha: string; // of the note text the vector was made from
  project: string | null;
}
export interface VectorHit {
  path: string;
  score: number; // cosine
}

interface Rows {
  dims: number;
  q: Int8Array;
  scale: Float32Array;
  metas: (VectorMeta | null)[]; // by slot; null: free
  slots: Map<string, number>; // path -> slot
  free: number[];
}

const MAGIC = 'cos-vectors-1';

function slotFor(r: Rows, path: string): number {
  const known = r.slots.get(path) ?? r.free.pop();
  if (known !== undefined) return known;
  const slot = r.metas.length;
  r.metas.push(null);
  if ((slot + 1) * r.dims > r.q.length) {
    const cap = Math.max(1024, slot * 2);
    const q = new Int8Array(cap * r.dims);
    q.set(r.q);
    const scale = new Float32Array(cap);
    scale.set(r.scale);
    r.q = q;
    r.scale = scale;
  }
  return slot;
}

function setRow(r: Rows, meta: VectorMeta, v: Float32Array) {
  const slot = slotFor(r, meta.path);
  let max = 0;
  for (let i = 0; i < r.dims; i++) max = Math.max(max, Math.abs(v[i]));
  const k = max ? 127 / max : 0;
  for (let i = 0; i < r.dims; i++) r.q[slot * r.dims + i] = Math.round(v[i] * k);
  r.scale[slot] = max / 127;
  r.metas[slot] = meta;
  r.slots.set(meta.path, slot);
}

// Keeps `best` sorted, at most k long.
function insert(best: VectorHit[], k: number, hit: VectorHit) {
  if (best.length === k && hit.score <= best[k - 1].score) return;
  let at = best.length === k ? k - 1 : best.length;
  while (at > 0 && best[at - 1].score < hit.score) {
    best[at] = best[at - 1];
    at--;
  }
  best[at] = hit;
}

function topIn(r: Rows, at: { query: Float32Array; k: number; project: string | null; best: VectorHit[] }, from: number, to: number): void {
  const { query, k, project, best } = at;
  const { dims, q } = r;
  for (let slot = from; slot < Math.min(to, r.metas.length); slot++) {
    const m = r.metas[slot];
    if (!m || (project !== null && m.project !== project)) continue;
    let dot = 0;
    for (let i = 0, o = slot * dims; i < dims; i++, o++) dot += query[i] * q[o];
    insert(best, k, { path: m.path, score: dot * r.scale[slot] });
  }
}

const top = (r: Rows, query: Float32Array, k: number, project: string | null): VectorHit[] => {
  const at = { query, k, project, best: [] };
  topIn(r, at, 0, r.metas.length);
  return at.best;
};

// Rows read per turn of the event loop: all 100k at once held the server for about 55 ms.
const TOP_ROWS = 10_000;

// The same in turns, so a search by meaning never holds the server; notes changed meanwhile count as they are then.
async function topLater(r: Rows, query: Float32Array, k: number, project: string | null): Promise<VectorHit[]> {
  const at = { query, k, project, best: [] };
  for (let from = 0; from < r.metas.length; from += TOP_ROWS) {
    if (from) await new Promise<void>((resolve) => nextTurn(resolve));
    topIn(r, at, from, from + TOP_ROWS);
  }
  return at.best;
}

// Live slots only, so a saved file carries no holes: header length, JSON header, the int8 rows, the scales.
function serialize(r: Rows, model: string): Buffer {
  const live = [...r.slots.values()];
  const header = Buffer.from(JSON.stringify({ magic: MAGIC, model, dims: r.dims, metas: live.map((s) => r.metas[s]) }));
  const rows = new Int8Array(live.length * r.dims);
  const scales = new Float32Array(live.length);
  live.forEach((s, i) => {
    rows.set(r.q.subarray(s * r.dims, (s + 1) * r.dims), i * r.dims);
    scales[i] = r.scale[s];
  });
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return Buffer.concat([len, header, Buffer.from(rows.buffer), Buffer.from(scales.buffer)]);
}

function storeOf(r: Rows) {
  return {
    set: (meta: VectorMeta, v: Float32Array) => setRow(r, meta, v),
    remove(path: string) {
      const slot = r.slots.get(path);
      if (slot === undefined) return;
      r.slots.delete(path);
      r.metas[slot] = null;
      r.free.push(slot);
    },
    // The k nearest notes to a normalized query, best first; project: only that one.
    top: (query: Float32Array, k: number, project: string | null) => top(r, query, k, project),
    topLater: (query: Float32Array, k: number, project: string | null) => topLater(r, query, k, project),
    serialize: (model: string) => serialize(r, model),
    get: (path: string): VectorMeta | undefined => {
      const slot = r.slots.get(path);
      return slot === undefined ? undefined : r.metas[slot]!;
    },
    paths: () => [...r.slots.keys()],
    size: () => r.slots.size,
    bytes: () => r.q.byteLength + r.scale.byteLength,
  };
}

export type Vectors = ReturnType<typeof storeOf>;

const emptyRows = (dims: number): Rows => ({ dims, q: new Int8Array(0), scale: new Float32Array(0), metas: [], slots: new Map(), free: [] });

export const createVectors = (dims: number): Vectors => storeOf(emptyRows(dims));

// A file of another model, another size or a broken one gives an empty store: the build makes it again.
export function loadVectors(buf: Buffer, model: string, dims: number): Vectors {
  try {
    const len = buf.readUInt32LE(0);
    const header = JSON.parse(buf.subarray(4, 4 + len).toString()) as { magic: string; model: string; dims: number; metas: VectorMeta[] };
    if (header.magic !== MAGIC || header.model !== model || header.dims !== dims) return createVectors(dims);
    const n = header.metas.length;
    const at = buf.byteOffset + 4 + len;
    const q = new Int8Array(buf.buffer.slice(at, at + n * dims));
    const scale = new Float32Array(buf.buffer.slice(at + n * dims, at + n * dims + n * 4));
    if (q.length !== n * dims || scale.length !== n) return createVectors(dims);
    return storeOf({ dims, q, scale, metas: header.metas, slots: new Map(header.metas.map((m, i) => [m.path, i])), free: [] });
  } catch {
    return createVectors(dims);
  }
}
