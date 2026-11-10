// The map of the universe: pure and deterministic, whatever order the data arrives in.
// A project is one central star and a small spiral around it, drawn from its own links: trees that cannot cross themselves, and the unlinked notes on arms.
// A note without links moves nothing when it appears; a linked one only nudges its siblings.
import type { MemoryGraph, MemoryNode } from '../../lib/types';

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
const SPIRAL = 3; // how fast the arms wind near the centre compared with the rim
const GOLDEN_ANGLE = 2.399963; // radians: seeds at this step never line up
const DISC_FILL = 0.6; // of the figure's area its groups' discs may take
const RIM_FILL = 0.05; // the same for groups beside a figure that fills the middle
const MAX_GROUP = 0.42; // the largest disc of a group, of the figure's radius
const CENTRAL_DISC = 0.74; // and of one that fills the middle
const BRANCH_RING = 0.5; // how far out a hub's branches stand, by the share of their area inside the ring
const BRANCH_REACH = Math.PI * 0.8; // the arc a branch may fill with branches of its own, away from its parent
const HUB_BESIDE = 0.1; // that one's hub, from the central star: right next to it and still within reach of the pointer
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
  /** Size factor from the number of links. */
  k: number;
  c: number;
  style: StarStyle;
}

export const STAR_MAIN = 0;
export const STAR_DWARF = 1;
export const STAR_GIANT = 2;
export const STAR_BINARY = 3;
export const STAR_PULSAR = 4;
export type StarStyle = 0 | 1 | 2 | 3 | 4;

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
}

export interface UniverseLayout {
  stars: Star[];
  constellations: Constellation[];
  links: Link[];
  /** Faint lines along the arms of a cluster. Purely visual: not links, never counted. */
  skeleton: [number, number][];
  /** From a constellation's central star to the first star of each of its groups: [constellation, star]. Purely visual as well. */
  spokes: [number, number][];
}

export function hash32(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

export function hash01(s: string, salt = 0): number {
  return hash32(s, salt) / 4294967296;
}

/** Angle of a logarithmic spiral arm at u, the share of the arm's full length. */
export function armAngle(arm: number, u: number): number {
  return (arm / ARMS) * TAU + Math.log(1 + 6 * u) * 2.05;
}

const GIANT_DEGREE = 6;

/** The kind of a star: hubs are giants, the rest comes from the note's id and never changes. Decoration, except that size means links. */
export function starStyle(id: string, degree: number): StarStyle {
  if (degree >= GIANT_DEGREE) return STAR_GIANT;
  const h = hash01(id, 31);
  if (h < 0.045) return STAR_PULSAR;
  if (h < 0.12) return STAR_BINARY;
  return degree === 0 && h < 0.6 ? STAR_DWARF : STAR_MAIN;
}

export function starSize(degree: number, style: StarStyle = STAR_MAIN): number {
  // A hub stands out and stays a note: the central star is the one big thing in a constellation.
  return (1 + Math.min(0.9, Math.sqrt(degree) * 0.28)) * (style === STAR_DWARF ? 0.72 : style === STAR_GIANT ? 1.12 : 1);
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

/** The core is not a figure: its knowledge lies around the nucleus, evenly by area. */
function corePosition(id: string, c: Pick<Constellation, 'x' | 'y' | 'z' | 'r'>): Vec3 {
  const a = hash01(id, 11) * TAU;
  const d = c.r * Math.sqrt(CORE_INNER ** 2 + hash01(id, 13) * (1 - CORE_INNER ** 2));
  return [c.x + Math.cos(a) * d, c.y + (hash01(id, 15) - 0.5) * c.r * 0.12, c.z + Math.sin(a) * d];
}

type Vec3 = [number, number, number];

interface ClusterShape {
  place: Map<string, Vec3>;
  /** Pairs of ids, "a|b" with a < b: the links the figure is drawn from. */
  tree: Set<string>;
  arms: [string, string][];
  /** The star of each group nearest to the centre. */
  firsts: string[];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * A small spiral galaxy around the central star. Every group of linked notes becomes a tree of little discs, one beside another: a hub's leaves lie
 * around it like seeds in a sunflower and its branches grow outwards, so the figure fills its area evenly and hardly ever crosses itself.
 * Notes without links run on arms between them, by topic. Then all of it winds the same way by the same law: that shared winding is
 * what makes one figure of many groups. Direction, winding, stretch and turn come from the key, so no two constellations share a silhouette.
 */
function shapeCluster(c: Constellation, nodes: MemoryNode[], edges: [string, string][]): ClusterShape {
  const key = c.key ?? '';
  const near = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (a === b) continue;
    near.get(a)?.push(b);
    near.get(b)?.push(a);
  }
  const degreeOf = (id: string) => near.get(id)?.length ?? 0;
  const byHub = nodes.slice().sort((a, b) => degreeOf(b.id) - degreeOf(a.id) || a.id.localeCompare(b.id));

  // Breadth first from the most linked note: the shortest branches. Children come after their parent, so walking back measures every subtree.
  const children = new Map<string, string[]>();
  const tree = new Set<string>();
  const seen = new Set<string>();
  const room = new Map<string, number>(); // the radius a subtree takes, in distances between two seeds
  const roots: { id: string; size: number }[] = [];
  for (const n of byHub) {
    if (seen.has(n.id) || degreeOf(n.id) === 0) continue;
    seen.add(n.id);
    const order = [n.id];
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const kids = [...new Set(near.get(id))].filter((x) => !seen.has(x)).sort((a, b) => hash32(a, 41) - hash32(b, 41) || a.localeCompare(b));
      children.set(id, kids);
      for (const kid of kids) {
        seen.add(kid);
        tree.add(pairKey(id, kid));
        order.push(kid);
      }
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const size = 1 + children.get(order[i])!.reduce((sum, kid) => sum + room.get(kid)! ** 2, 0);
      room.set(order[i], Math.sqrt(size));
    }
    roots.push({ id: n.id, size: order.length });
  }

  // The rest, on arms by topic: the first two words of the file name (project_billing_...).
  const armCount = 4 + (hash32(key, 23) % 4);
  const armsOf = new Map<number, MemoryNode[]>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const words = n.file.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const arm = hash32(words.slice(0, 2).join(' '), 12) % armCount;
    const list = armsOf.get(arm);
    if (list) list.push(n);
    else armsOf.set(arm, [n]);
  }

  // One group holding most of the project: its hub stands right by the central star and its seeds go all the way round. The others keep to the rim.
  const central = roots.length && roots[0].size * 2 >= nodes.length ? roots[0] : null;
  const rootsLeft = roots.filter((root) => root !== central);
  const scale = Math.min(MAX_GROUP / Math.max(...rootsLeft.map((root) => room.get(root.id)!), 1), Math.sqrt((central ? RIM_FILL : DISC_FILL) / Math.max(1, rootsLeft.reduce((sum, root) => sum + room.get(root.id)! ** 2, 0))));

  // A sector for every group, in an order that a new group does not shuffle.
  type Group = { sort: number; weight: number; root?: (typeof roots)[number]; arm?: MemoryNode[] };
  const groups: Group[] = [
    ...rootsLeft.map((root) => ({ sort: hash32(root.id, 42), weight: room.get(root.id)! * scale * 6 + 0.5, root })),
    ...[...armsOf].map(([arm, list]) => ({ sort: hash32(`${key}${arm}`, 43), weight: list.length ** 0.6, arm: list })),
  ].sort((a, b) => a.sort - b.sort);
  const total = groups.reduce((sum, g) => sum + g.weight, 0);

  const turn = hash01(key, 24) * TAU;
  const wind = (hash01(key, 25) < 0.5 ? -1 : 1) * (0.55 + hash01(key, 26) * 0.5);
  const stretch = 1 + hash01(key, 22) * 0.2;
  const skew = hash01(key, 21) * TAU;
  const place = new Map<string, Vec3>();
  // `along` from the centre of the figure to its rim. The hole around the central star comes in here, so nothing else has to mind it.
  const put = (id: string, angle: number, along: number, hole = true) => {
    const out = hole ? CENTER_CLEAR + (1 - CENTER_CLEAR) * Math.min(1, along) : along;
    const a = angle + wind * Math.log(1 + SPIRAL * out);
    const d = out * c.r;
    const lx = Math.cos(a) * d * stretch;
    const lz = (Math.sin(a) * d) / stretch;
    place.set(id, [c.x + lx * Math.cos(skew) - lz * Math.sin(skew), c.y + (hash01(id, 15) - 0.5) * c.r * 0.2 * out, c.z + lx * Math.sin(skew) + lz * Math.cos(skew)]);
  };
  const putAt = (id: string, x: number, z: number) => put(id, Math.atan2(z, x), Math.hypot(x, z));
  // A subtree in its disc, x and z in the figure's terms. A hub's leaves lie around it like seeds in a sunflower. Its branches stand just outside them, each
  // with an arc by its area, and grow away from their parent, `reach` being how much of the circle they may have: an even fill and hardly a crossing.
  const grow = (id: string, x: number, z: number, unit: number, out: number, reach: number) => {
    putAt(id, x, z);
    const kids = children.get(id)!;
    const branches = kids.filter((kid) => children.get(kid)!.length > 0);
    const seeds = kids.length - branches.length;
    const start = hash01(id, 45) * TAU;
    let seed = 0;
    for (const kid of kids) {
      if (children.get(kid)!.length > 0) continue;
      const d = unit * Math.sqrt(seed + 0.5) * (1 + (hash01(kid, 44) - 0.5) * 0.1);
      const a = start + seed * GOLDEN_ANGLE;
      putAt(kid, x + Math.cos(a) * d, z + Math.sin(a) * d);
      seed++;
    }
    const area = branches.reduce((sum, kid) => sum + room.get(kid)! ** 2, 0);
    let a = out - reach / 2;
    for (const kid of branches) {
      const arc = (reach * room.get(kid)! ** 2) / area;
      const d = unit * (Math.sqrt(seeds + area * BRANCH_RING) + (hash01(kid, 44) - 0.5) * room.get(kid)! * 0.5);
      a += arc / 2;
      grow(kid, x + Math.cos(a) * d, z + Math.sin(a) * d, unit, a, Math.min(BRANCH_REACH, reach));
      a += arc / 2;
    }
  };

  const arms: [string, string][] = [];
  const firsts: string[] = [];
  if (central) {
    const unit = CENTRAL_DISC / room.get(central.id)!;
    grow(central.id, 0, 0, unit, turn, TAU);
    put(central.id, turn, HUB_BESIDE, false);
  }
  let start = turn;
  for (const g of groups) {
    const span = (g.weight / total) * TAU;
    const middle = start + span / 2;
    if (g.root) {
      const r = room.get(g.root.id)! * scale;
      // As close to the centre as its sector lets it: the sector narrows inwards, the disc does not.
      const fit = span < Math.PI ? r / Math.sin(span / 2) : r;
      const along = central ? 1 - r : Math.min(1 - r, Math.max(r + 0.03, fit));
      grow(g.root.id, Math.cos(middle) * along, Math.sin(middle) * along, scale, middle, TAU);
      firsts.push(g.root.id);
    } else {
      // A dotted line, evenly: the eye reads a line of even steps as one curve. With a whole figure inside it runs along the rim instead of through it.
      const list = g.arm!.map((n) => n.id).sort((x, y) => hash32(x, 11) - hash32(y, 11) || x.localeCompare(y));
      const from = central ? CENTRAL_DISC + 0.1 : 0.04 + hash01(`${key}${g.sort}`, 46) * 0.1;
      const to = central ? 0.98 : Math.min(0.98, from + 0.17 * Math.sqrt(list.length));
      const arc = central ? span * 0.8 : 0;
      list.forEach((id, i) => {
        const t = (i + 0.5) / list.length;
        put(id, middle + (t - 0.5) * arc + (hash01(id, 13) - 0.5) * 0.09, from + (to - from) * t);
        if (i > 0) arms.push([list[i - 1], id]);
      });
      firsts.push(list[0]);
    }
    start += span;
  }
  return { place, tree, arms, firsts };
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
  const inside = new Map<string | null, [string, string][]>();
  for (const e of sorted) {
    const owner = ownerOf.get(e[0]);
    if (owner === undefined || owner !== ownerOf.get(e[1])) continue;
    const list = inside.get(owner);
    if (list) list.push(e);
    else inside.set(owner, [e]);
  }

  const stars: Star[] = [];
  const figure = new Set<string>();
  const skeletonIds: [string, string][] = [];
  const spokeIds: [number, string][] = [];
  const constellations = keys.map((key) => constellationAt(key, key === coreKey, slots, groups.get(key)!.length));
  constellations.forEach((c, ci) => {
    const nodes = groups.get(c.key)!.slice().sort((a, b) => a.id.localeCompare(b.id));
    const shape = c.core ? null : shapeCluster(c, nodes, inside.get(c.key) ?? []);
    if (shape) {
      for (const pair of shape.tree) figure.add(pair);
      skeletonIds.push(...shape.arms);
      for (const id of shape.firsts) spokeIds.push([ci, id]);
    }
    for (const node of nodes) {
      const [x, y, z] = shape ? shape.place.get(node.id)! : corePosition(node.id, c);
      const style = starStyle(node.id, node.degree);
      c.stars.push(stars.length);
      stars.push({ node, x, y, z, k: starSize(node.degree, style), c: ci, style });
    }
  });

  const index = new Map(stars.map((s, i) => [s.node.id, i]));
  const links: Link[] = [];
  for (const [a, b] of graph.edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined && ia !== ib) links.push({ a: ia, b: ib, cross: stars[ia].c !== stars[ib].c, tree: figure.has(pairKey(a, b)) });
  }
  const skeleton = skeletonIds.map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]);
  const spokes = spokeIds.map(([c, id]) => [c, index.get(id)!] as [number, number]);
  return { stars, constellations, links, skeleton, spokes };
}
