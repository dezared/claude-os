// A force-directed figure for one group of linked notes: links pull, every note pushes its neighbours away, a weak pull holds the
// group together. Seeded by the note ids and run for a fixed number of steps in a fixed order, so the same notes give the same figure.
// Math.sqrt, not Math.hypot, in the loops: hypot is several times slower and its garbage was most of the cost.
import { hash01 } from './hash.ts';

/** A link inside the group: local indices and its strength, 0 to 1. */
export interface ForceEdge {
  a: number;
  b: number;
  w: number;
  /** Outside the figure: it pulls only gently, or the figure folds over itself to shorten it. */
  loose: boolean;
}

const CUTOFF = 2.6; // notes farther apart than this do not push each other: a grid instead of all pairs
const PUSH = 0.9;
const GRAVITY = 0.015;
const MIN_STEPS = 60;
const MAX_STEPS = 260;
const LOOSE = 0.15;
const SMALL = 64;
const WORK = 40000; // node steps a group may cost

interface Grid {
  w: number;
  h: number;
  cell: Int32Array; // of each note
  start: Int32Array; // of each cell in order, one past the last at the end
  order: Int32Array; // notes sorted by cell
}

/** Notes sorted into CUTOFF cells by a counting sort: no maps and no garbage in the hot loop. */
function gridOf(pos: Float64Array): Grid {
  const n = pos.length / 2;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, pos[i * 2]);
    x1 = Math.max(x1, pos[i * 2]);
    y0 = Math.min(y0, pos[i * 2 + 1]);
    y1 = Math.max(y1, pos[i * 2 + 1]);
  }
  const w = Math.floor((x1 - x0) / CUTOFF) + 1;
  const h = Math.floor((y1 - y0) / CUTOFF) + 1;
  const cell = new Int32Array(n);
  const start = new Int32Array(w * h + 1);
  for (let i = 0; i < n; i++) {
    cell[i] = Math.floor((pos[i * 2] - x0) / CUTOFF) + Math.floor((pos[i * 2 + 1] - y0) / CUTOFF) * w;
    start[cell[i] + 1]++;
  }
  for (let c = 0; c < w * h; c++) start[c + 1] += start[c];
  const fill = start.slice(0, w * h);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[cell[i]]++] = i;
  return { w, h, cell, start, order };
}

/** Repulsion between neighbours: 2D Coulomb, fading to zero at the cutoff, so a crowd spreads into an even disc. */
function repel(pos: Float64Array, disp: Float64Array) {
  const n = pos.length / 2;
  // A small group is cheaper pair by pair than through a grid built anew every step.
  if (n <= SMALL) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pushPair(pos, disp, i, j);
    return;
  }
  const g = gridOf(pos);
  for (let i = 0; i < n; i++) {
    const cx = g.cell[i] % g.w;
    const cy = Math.floor(g.cell[i] / g.w);
    for (let y = Math.max(0, cy - 1); y <= Math.min(g.h - 1, cy + 1); y++) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(g.w - 1, cx + 1); x++) pushCell(pos, disp, i, [g, x + y * g.w]);
    }
  }
}

/** i against the notes of one cell after it in order: each pair once. */
function pushCell(pos: Float64Array, disp: Float64Array, i: number, [g, c]: [Grid, number]) {
  for (let k = g.start[c]; k < g.start[c + 1]; k++) if (g.order[k] > i) pushPair(pos, disp, i, g.order[k]);
}

function pushPair(pos: Float64Array, disp: Float64Array, i: number, j: number) {
  const dx = pos[i * 2] - pos[j * 2];
  const dy = pos[i * 2 + 1] - pos[j * 2 + 1];
  const d = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  if (d >= CUTOFF) return;
  const f = (PUSH * (1 / d - 1 / CUTOFF)) / d;
  disp[i * 2] += dx * f;
  disp[i * 2 + 1] += dy * f;
  disp[j * 2] -= dx * f;
  disp[j * 2 + 1] -= dy * f;
}

/** A strong link is short and stiff, a weak one long and slack. */
function pull(pos: Float64Array, disp: Float64Array, edges: ForceEdge[]) {
  for (const { a, b, w, loose } of edges) {
    const dx = pos[b * 2] - pos[a * 2];
    const dy = pos[b * 2 + 1] - pos[a * 2 + 1];
    const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
    const f = ((0.3 + 0.7 * w) * (loose ? LOOSE : 1) * (d - (1.2 - 0.6 * w))) / d / 2;
    disp[a * 2] += dx * f;
    disp[a * 2 + 1] += dy * f;
    disp[b * 2] -= dx * f;
    disp[b * 2 + 1] -= dy * f;
  }
}

/** Positions, x and y in turn, about one link long apart and centred on zero. ids are sorted by the caller. */
export function relax(ids: string[], edges: ForceEdge[]): Float64Array {
  const n = ids.length;
  const pos = new Float64Array(n * 2);
  const spread = Math.sqrt(n);
  ids.forEach((id, i) => {
    const a = hash01(id, 71) * Math.PI * 2;
    const d = Math.sqrt(hash01(id, 72)) * spread;
    pos[i * 2] = Math.cos(a) * d;
    pos[i * 2 + 1] = Math.sin(a) * d;
  });
  if (n < 2) return pos.fill(0);
  // A few notes settle in few steps; a large group gets fewer, longer ones.
  const steps = Math.max(MIN_STEPS, Math.min(MAX_STEPS, MIN_STEPS + 4 * n, Math.round(WORK / n)));
  const disp = new Float64Array(n * 2);
  for (let s = 0; s < steps; s++) {
    disp.fill(0);
    repel(pos, disp);
    pull(pos, disp, edges);
    // Cooling: big moves while the figure unfolds, small ones while it settles.
    const limit = 0.05 + (spread * 0.3 * (steps - s)) / steps;
    for (let i = 0; i < n * 2; i++) disp[i] -= pos[i] * GRAVITY;
    for (let i = 0; i < n; i++) {
      const m = Math.sqrt(disp[i * 2] ** 2 + disp[i * 2 + 1] ** 2);
      const k = m > limit ? limit / m : 1;
      pos[i * 2] += disp[i * 2] * k;
      pos[i * 2 + 1] += disp[i * 2 + 1] * k;
    }
  }
  return centred(pos);
}

function centred(pos: Float64Array): Float64Array {
  const n = pos.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pos[i * 2] / n;
    cy += pos[i * 2 + 1] / n;
  }
  for (let i = 0; i < n; i++) {
    pos[i * 2] -= cx;
    pos[i * 2 + 1] -= cy;
  }
  return pos;
}
