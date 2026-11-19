// One constellation in a unit disc. Every group of linked notes gets its own force-directed figure, the groups are scattered
// over the disc apart from each other, and the notes without links fill the free sky between them. All of it is seeded by ids.
import { relax, type ForceEdge } from './force.ts';
import { hash01 } from './hash.ts';

type Pt = [number, number];

export interface ClusterPlan {
  /** x and z in the disc's terms, radius 1. */
  place: Map<string, Pt>;
  /** Pairs "a|b", a < b: the strongest links that hold each group together, the figure that stays bright. */
  tree: Set<string>;
  /** The most linked note of each group, the largest group first. */
  hubs: string[];
}

const GAP = 1.6; // between two groups, in link lengths
const LONE_ROOM = 1.1; // the room a note without links takes, the same units
const FILL = 0.45; // of the disc's area its notes may take: the rest is the sky between them
const TRIES = 40;
const LONE_TRIES = 10;
const TAU = Math.PI * 2;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The strongest links first, each one that joins two groups kept: a maximum spanning forest. Its trees are the groups. */
function forest(ids: string[], edges: [string, string, number][]) {
  const up = new Map(ids.map((id) => [id, id]));
  const root = (id: string): string => {
    let r = id;
    while (up.get(r) !== r) r = up.get(r)!;
    up.set(id, r);
    return r;
  };
  const tree = new Set<string>();
  const sorted = edges.slice().sort((x, y) => y[2] - x[2] || pairKey(x[0], x[1]).localeCompare(pairKey(y[0], y[1])));
  for (const [a, b] of sorted) {
    const ra = root(a);
    const rb = root(b);
    if (ra === rb) continue;
    up.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    tree.add(pairKey(a, b));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const list = groups.get(root(id));
    if (list) list.push(id);
    else groups.set(root(id), [id]);
  }
  // Every link by its group, so that each figure walks only its own.
  const linksOf = new Map<string, [string, string, number][]>();
  for (const e of edges) {
    const list = linksOf.get(root(e[0]));
    if (list) list.push(e);
    else linksOf.set(root(e[0]), [e]);
  }
  return { tree, groups: [...groups].filter(([, g]) => g.length > 1).map(([r, g]) => ({ ids: g, edges: linksOf.get(r)! })) };
}

interface Figure {
  ids: string[];
  pos: Float64Array;
  r: number;
  hub: string;
}

/** ids of one group, edges all inside it. */
function figureOf(ids: string[], edges: [string, string, number][], tree: Set<string>, degree: (id: string) => number): Figure {
  const index = new Map(ids.map((id, i) => [id, i]));
  const own: ForceEdge[] = edges.map(([a, b, w]) => ({ a: index.get(a)!, b: index.get(b)!, w, loose: !tree.has(pairKey(a, b)) }));
  const pos = relax(ids, own);
  let r = 0;
  for (let i = 0; i < ids.length; i++) r = Math.max(r, Math.hypot(pos[i * 2], pos[i * 2 + 1]));
  const hub = ids.reduce((best, id) => (degree(id) > degree(best) ? id : best), ids[0]);
  return { ids, pos, r: r + 0.6, hub };
}

/** A random-looking point of the annulus, even by area. */
function pointIn(id: string, salt: number, inner: number, outer: number): Pt {
  const a = hash01(id, salt) * TAU;
  const d = Math.sqrt(inner * inner + hash01(id, salt + 1) * (outer * outer - inner * inner));
  return [Math.cos(a) * d, Math.sin(a) * d];
}

/** The deepest overlap of a circle at p with the placed ones, given up once it is no better than `enough`. */
function overlapOf(placed: [number, number, number][], p: Pt, r: number, enough: number): number {
  let overlap = -Infinity;
  for (const [x, y, q] of placed) {
    overlap = Math.max(overlap, q + r + GAP - Math.hypot(p[0] - x, p[1] - y));
    if (overlap >= enough) break;
  }
  return overlap;
}

/** Each group where it overlaps nothing placed before it; failing that, where it overlaps least. */
function packFigures(figures: Figure[], disc: number): Pt[] {
  const placed: [number, number, number][] = [];
  return figures.map((f) => {
    let best: Pt = [0, 0];
    let worst = Infinity;
    for (let k = 0; k < TRIES && worst > 0; k++) {
      const p = pointIn(f.hub, 80 + k * 2, 0, Math.max(0, disc - f.r));
      const overlap = overlapOf(placed, p, f.r, worst);
      if (overlap < worst) [best, worst] = [p, overlap];
    }
    placed.push([best[0], best[1], f.r]);
    return best;
  });
}

/** Grid lookup of the squared distance to the nearest placed note, for the notes without links: they take the emptiest of a few random places. */
function nearestOf(points: Pt[]) {
  const cells = new Map<number, Pt[]>();
  const cell = (cx: number, cy: number) => (cx + 32768) * 65536 + cy + 32768;
  for (const p of points) {
    const key = cell(Math.floor(p[0] / 2), Math.floor(p[1] / 2));
    const list = cells.get(key);
    if (list) list.push(p);
    else cells.set(key, [p]);
  }
  return (x: number, y: number) => {
    let d2 = 16;
    const cx = Math.floor(x / 2);
    const cy = Math.floor(y / 2);
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) for (const p of cells.get(cell(cx + i, cy + j)) ?? []) d2 = Math.min(d2, (p[0] - x) ** 2 + (p[1] - y) ** 2);
    }
    return d2;
  };
}

/** The disc for the whole constellation: ids sorted, edges inside it with their strength, the hole kept for the central star. */
export function planCluster(ids: string[], edges: [string, string, number][], degree: (id: string) => number, hole: number): ClusterPlan {
  const { tree, groups } = forest(ids, edges);
  const figures = groups.map((g) => figureOf(g.ids, g.edges, tree, degree)).sort((a, b) => b.ids.length - a.ids.length || a.hub.localeCompare(b.hub));
  const linked = new Set(groups.flatMap((g) => g.ids));
  const lone = ids.filter((id) => !linked.has(id));
  const area = figures.reduce((sum, f) => sum + Math.PI * (f.r + GAP / 2) ** 2, 0) + lone.length * Math.PI * LONE_ROOM ** 2;
  const disc = Math.max(4, Math.sqrt(area / (Math.PI * FILL)));
  const place = new Map<string, Pt>();
  packFigures(figures, disc).forEach(([x, y], k) => {
    const f = figures[k];
    const turn = hash01(f.hub, 79) * TAU;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    f.ids.forEach((id, i) => place.set(id, [x + f.pos[i * 2] * c - f.pos[i * 2 + 1] * s, y + f.pos[i * 2] * s + f.pos[i * 2 + 1] * c]));
  });
  const room = nearestOf([...place.values()]);
  for (const id of lone) {
    let best: Pt = [0, 0];
    let free = -1;
    for (let k = 0; k < LONE_TRIES; k++) {
      const p = pointIn(id, 120 + k * 2, 0, disc);
      const d = room(p[0], p[1]);
      if (d > free) [best, free] = [p, d];
    }
    place.set(id, best);
  }
  return { place: toUnit(place, disc, hole), tree, hubs: figures.map((f) => f.hub) };
}

/** Into the unit disc, then out of the central star's hole: the disc is stretched onto the ring around it so that every part keeps its share of the area. */
function toUnit(place: Map<string, Pt>, disc: number, hole: number): Map<string, Pt> {
  const far = Math.max(disc, ...[...place.values()].map(([x, y]) => Math.hypot(x, y)));
  for (const [id, [x, y]] of place) {
    const r = Math.hypot(x, y) / far;
    const out = Math.sqrt(hole * hole + (1 - hole * hole) * r * r);
    place.set(id, r > 0 ? [(x / far) * (out / r), (y / far) * (out / r)] : [hole, 0]);
  }
  return place;
}
