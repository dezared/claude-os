// The map of the universe: pure and deterministic, whatever order the data arrives in.
// A project is one central star and its notes around it: linked notes drawn close by a force-directed figure, groups and the notes
// without links apart (cluster.ts). A note without links moves nothing when it appears; a linked one only reshapes its own group.
import type { MemoryGraph, MemoryNode } from '../../lib/types';
import { pairKey, planCluster } from './cluster.ts';
import { hash01, hash32 } from './hash.ts';

export { hash01, hash32 };

export const ARMS = 4;
/** The dust arms run this many disc radii out: past the constellations, to the edges of the window. */
export const REACH = 1.95;
/** Radius of the disc that holds the constellations. A constant: note counts must not rescale the map. */
export const R = 560;
const TAU = Math.PI * 2;
const CORE_RADIUS = 88;
const CORE_INNER = 0.42; // the core's notes keep clear of the bright nucleus
const MIN_RADIUS = 44;
const MAX_RADIUS = 112;
const FULL_CLUSTER = 260; // notes at which a constellation stops growing
const CENTER_CLEAR = 0.22; // the share of the radius that belongs to the central star
// Between two constellations: different every time, never less than two of the largest can stand side by side.
const MIN_GAP = 200;
const GAP_SPREAD = 90;
const CORE_GAP = 200;
const ARM_WOBBLE = 70;
const FILL_STEP = 235;
const FILL_WOBBLE = 90;

export interface Star {
  node: MemoryNode;
  x: number;
  y: number;
  z: number;
  /** Size factor: the number of links, varied a little by the note's id. */
  k: number;
  c: number;
}

export interface Constellation {
  key: string | null;
  x: number;
  y: number;
  z: number;
  r: number;
  stars: number[];
  /** The centre of the galaxy: Claude OS itself and the global notes. */
  core: boolean;
}

export interface Link {
  a: number;
  b: number;
  cross: boolean;
  /** Part of the constellation's figure. The rest of a project's own links stay faint until a star is hovered: they are what would turn it into a tangle. */
  tree: boolean;
  /** Strength, 0 to 1: how much the two notes share their neighbours. A strong link is short on the map and drawn thicker. */
  w: number;
}

export interface UniverseLayout {
  stars: Star[];
  constellations: Constellation[];
  links: Link[];
  /** From a constellation's central star to the most linked note of each of its groups: [constellation, star]. Purely visual: not links, never counted. */
  spokes: [number, number][];
}

/** Angle of a logarithmic spiral arm at u, the share of the arm's full length. */
export function armAngle(arm: number, u: number): number {
  return (arm / ARMS) * TAU + Math.log(1 + 6 * u) * 2.05;
}

const SIZE_SPREAD = 0.45; // of a star's size that comes from its id: stars of the same degree differ

/** Hubs are larger; within a degree the size varies by the note's id, which never changes. */
export function starSize(degree: number, id = ''): number {
  return (1 + Math.min(0.9, Math.sqrt(degree) * 0.28)) * (1 - SIZE_SPREAD / 2 + hash01(id, 31) * SIZE_SPREAD);
}

// Places for constellations along the arms, inner first. The steps along an arm differ, so do the distances across it.
const SLOT_TABLE: [number, number][] = [];
const roomFor = (x: number, z: number) => {
  const gap = MIN_GAP + hash01(`gap${SLOT_TABLE.length}`, 7) * GAP_SPREAD;
  return !SLOT_TABLE.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < gap);
};
let insideDisc = 0;
for (let d = CORE_GAP + ARM_WOBBLE / 2; d < R * 2.2; d += 12) {
  for (let arm = 0; arm < ARMS; arm++) {
    const a = armAngle(arm, d / (R * REACH));
    const across = (hash01(`${arm}:${d}`, 8) - 0.5) * ARM_WOBBLE;
    const x = Math.cos(a) * d - Math.sin(a) * across;
    const z = Math.sin(a) * d + Math.cos(a) * across;
    if (!roomFor(x, z)) continue;
    SLOT_TABLE.push([x, z]);
    if (d <= R) insideDisc++;
  }
}

// The arms run out at a few dozen places. The rest fills the gaps between them, nearest to the centre first, so that a
// map of a hundred projects stays one disc instead of stacking on the last place.
const SKY_GAPS: [number, number][] = [];
for (let row = -14; row <= 14; row++) {
  for (let col = -14; col <= 14; col++) {
    const x = (col + (row & 1) / 2) * FILL_STEP + (hash01(`${row}:${col}`, 9) - 0.5) * FILL_WOBBLE;
    const z = (row * FILL_STEP * Math.sqrt(3)) / 2 + (hash01(`${row}:${col}`, 10) - 0.5) * FILL_WOBBLE;
    if (Math.hypot(x, z) >= CORE_GAP) SKY_GAPS.push([x, z]);
  }
}
SKY_GAPS.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
for (const [x, z] of SKY_GAPS) if (roomFor(x, z)) SLOT_TABLE.push([x, z]);

/** How many projects can have a place of their own. */
export const SLOT_COUNT = SLOT_TABLE.length;

/**
 * Hands out places by project key. A place once given is kept: during a session nothing ever moves.
 * Between launches the same projects get the same places; keys are served in hash order for that.
 */
export class Slots {
  private byKey = new Map<string, number>();
  private taken = new Set<number>();

  place(key: string): [number, number] {
    let slot = this.byKey.get(key);
    if (slot === undefined) {
      slot = hash32(key, 2) % insideDisc;
      // Past the disc only when it is full: the arms have room for more than anyone will have projects.
      while (this.taken.has(slot) && slot < SLOT_TABLE.length - 1) slot = this.taken.size >= insideDisc ? slot + 1 : (slot + 1) % insideDisc;
      this.taken.add(slot);
      this.byKey.set(key, slot);
    }
    return SLOT_TABLE[slot];
  }

  placeAll(keys: Iterable<string>) {
    for (const key of [...keys].sort((a, b) => hash32(a, 3) - hash32(b, 3) || a.localeCompare(b))) this.place(key);
  }
}

/** Radius of a project's constellation: by how many notes it holds, in steps, so one more note rarely changes it. */
function clusterRadius(key: string | null, core: boolean, notes: number): number {
  if (core) return CORE_RADIUS;
  const size = MIN_RADIUS + Math.min(1, Math.sqrt(notes / FULL_CLUSTER)) * (MAX_RADIUS - MIN_RADIUS - 4);
  return Math.round(size / 6) * 6 + hash01(key ?? '', 5) * 4;
}

/**
 * The strength of every link: the share of neighbours the two notes have in common, themselves included (Jaccard). Two notes that
 * only link each other, or a tight triangle, are strong; a hub's link to one of a hundred leaves is weak.
 */
function linkStrength(edges: [string, string][]): (a: string, b: string) => number {
  const near = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = near.get(a);
    if (set) set.add(b);
    else near.set(a, new Set([a, b]));
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  return (a, b) => {
    const [x, y] = [near.get(a), near.get(b)];
    if (!x || !y) return 0;
    const [small, big] = x.size < y.size ? [x, y] : [y, x];
    let both = 0;
    for (const id of small) if (big.has(id)) both++;
    return both / (x.size + y.size - both);
  };
}

export function constellationAt(key: string | null, core: boolean, slots: Slots, notes = 0): Constellation {
  const [x, z] = core ? [0, 0] : slots.place(key ?? '');
  return { key, x, y: core ? 0 : (hash01(key ?? '', 4) - 0.5) * R * 0.14, z, r: clusterRadius(key, core, notes), stars: [], core };
}

export function layoutUniverse(graph: Pick<MemoryGraph, 'nodes' | 'edges'> & { coreProject?: string | null }, slots = new Slots()): UniverseLayout {
  const coreKey = graph.coreProject ?? null;
  const groups = new Map<string | null, MemoryNode[]>([[coreKey, []]]);
  const ownerOf = new Map<string, string | null>();
  for (const n of graph.nodes) {
    const key = n.project ?? coreKey;
    ownerOf.set(n.id, key);
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  slots.placeAll(keys.filter((k): k is string => k !== coreKey && k !== null));

  // Sorted first: the map must not depend on the order links arrive in.
  const sorted = graph.edges.map(([a, b]) => (a < b ? [a, b] : [b, a]) as [string, string]).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  const strength = linkStrength(sorted);
  const inside = new Map<string | null, [string, string, number][]>();
  for (const [a, b] of sorted) {
    const owner = ownerOf.get(a);
    if (owner === undefined || owner !== ownerOf.get(b) || a === b) continue;
    const list = inside.get(owner);
    if (list) list.push([a, b, strength(a, b)]);
    else inside.set(owner, [[a, b, strength(a, b)]]);
  }

  const stars: Star[] = [];
  const figure = new Set<string>();
  const spokeIds: [number, string][] = [];
  const constellations = keys.map((key) => constellationAt(key, key === coreKey, slots, groups.get(key)!.length));
  constellations.forEach((c, ci) => {
    const nodes = groups.get(c.key)!.slice().sort((a, b) => a.id.localeCompare(b.id));
    const degree = new Map(nodes.map((n) => [n.id, n.degree]));
    const plan = planCluster(nodes.map((n) => n.id), inside.get(c.key) ?? [], (id) => degree.get(id) ?? 0, c.core ? CORE_INNER : CENTER_CLEAR);
    for (const pair of plan.tree) figure.add(pair);
    // The core is not a figure: no spokes from its bright nucleus.
    if (!c.core) for (const id of plan.hubs) spokeIds.push([ci, id]);
    for (const node of nodes) {
      const [ux, uz] = plan.place.get(node.id)!;
      const out = Math.hypot(ux, uz);
      c.stars.push(stars.length);
      stars.push({ node, x: c.x + ux * c.r, y: c.y + (hash01(node.id, 15) - 0.5) * c.r * 0.2 * out, z: c.z + uz * c.r, k: starSize(node.degree, node.id), c: ci });
    }
  });

  const index = new Map(stars.map((s, i) => [s.node.id, i]));
  const links: Link[] = [];
  for (const [a, b] of graph.edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined && ia !== ib) links.push({ a: ia, b: ib, cross: stars[ia].c !== stars[ib].c, tree: figure.has(pairKey(a, b)), w: strength(a, b) });
  }
  const spokes = spokeIds.map(([c, id]) => [c, index.get(id)!] as [number, number]);
  return { stars, constellations, links, spokes };
}
