// The map of the universe is pure code: no browser needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constellationAt, layoutUniverse, R, Slots, STAR_GIANT, STAR_PULSAR, starSize, starStyle } from '../web/src/home/universe/layout.ts';
import { syntheticGraph } from './fixture-server.ts';

const names = ['alpha-service', 'beta-tools', 'gamma', 'delta-backend', 'epsilon', 'zeta-bot', 'eta', 'theta'];

test('same notes give the same map, whatever the order they arrive in', () => {
  const graph = syntheticGraph(173, names);
  const a = layoutUniverse(graph);
  const b = layoutUniverse({ ...graph, nodes: graph.nodes.slice().reverse(), edges: graph.edges.slice().reverse() });
  const pos = (l: typeof a) => Object.fromEntries(l.stars.map((s) => [s.node.id, [s.x, s.y, s.z]]));
  assert.deepEqual(pos(b), pos(a));
  assert.equal(a.stars.length, 173);
});

test('every project is a constellation, none overlap', () => {
  const graph = syntheticGraph(400, names);
  const { constellations: list } = layoutUniverse(graph);
  assert.equal(list.length, new Set([...graph.nodes.map((n) => n.project), graph.coreProject]).size);
  for (const c of list) assert.ok(Math.hypot(c.x, c.z) <= R + 1, `${c.key} left the disc`);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
      assert.ok(d > (list[i].r + list[j].r) * 0.8, `${list[i].key} and ${list[j].key} overlap`);
    }
  }
});

test('a note without links moves nothing; a linked note only nudges its neighbours; a new link stays inside the figure', () => {
  const graph = syntheticGraph(173, names);
  const pos = (l: ReturnType<typeof layoutUniverse>) => new Map(l.stars.map((s) => [s.node.id, [s.x, s.y, s.z]]));
  const before = pos(layoutUniverse(graph));
  const lone = { id: 'new-1', title: 'new', file: 'new.md', project: 'theta', connected: true, degree: 0, live: false, mtime: 0, summary: null, issues: [] };
  const after = pos(layoutUniverse({ ...graph, nodes: [...graph.nodes, lone] }));
  assert.equal(after.size, before.size + 1);
  const moved = (a: Map<string, number[]>, list: Map<string, number[]>) => Math.max(...[...list].map(([id, p]) => Math.hypot(p[0] - a.get(id)![0], p[2] - a.get(id)![2])));
  after.delete('new-1');
  assert.ok(moved(before, after) < 30, 'a lone note shook the figure');
  // Other projects do not feel it at all.
  const other = graph.nodes.find((n) => n.project === names[1])!;
  const big = pos(layoutUniverse({ ...graph, nodes: [...graph.nodes, { ...lone, project: names[0] }], edges: [...graph.edges, ['new-1', graph.nodes.find((n) => n.project === names[0])!.id]] }));
  assert.deepEqual(big.get(other.id), before.get(other.id));
});

test('a constellation is a figure: its bright lines form a tree that barely crosses itself', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, title: `s${i}`, file: `s${i}.md`, project: 'solo', connected: true, degree: 0, live: false, mtime: 0, summary: null, issues: [] }));
  const edges: [string, string][] = [];
  for (let i = 1; i < 60; i++) edges.push([`s${i}`, `s${Math.floor(((i * 7919) % 97) / 97 * i)}`]);
  for (let i = 0; i < 25; i++) edges.push([`s${(i * 13) % 60}`, `s${(i * 37 + 11) % 60}`]); // links the tree does not need
  const l = layoutUniverse({ nodes, edges, coreProject: null });
  const tree = l.links.filter((x) => x.tree);
  assert.ok(tree.length >= 50 && tree.length < l.links.length, `${tree.length} of ${l.links.length} lines in the figure`);
  const crossings = (list: typeof l.links) => {
    const side = (a: typeof l.stars[0], b: typeof l.stars[0], c: typeof l.stars[0]) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [p, q, r, s] = [list[i].a, list[i].b, list[j].a, list[j].b];
        if (p === r || p === s || q === r || q === s) continue;
        const [P, Q, S, T] = [l.stars[p], l.stars[q], l.stars[r], l.stars[s]];
        if (side(P, Q, S) * side(P, Q, T) < 0 && side(S, T, P) * side(S, T, Q) < 0) n++;
      }
    }
    return n;
  };
  const all = crossings(l.links);
  const figure = crossings(tree);
  assert.ok(figure <= 3, `${figure} crossings in the figure`);
  assert.ok(figure < all / 5, `${figure} of ${all}`);
});

test('hubs are larger, kinds of star come from the note alone, and they differ', () => {
  const graph = syntheticGraph(800, names);
  const a = layoutUniverse(graph);
  const b = layoutUniverse({ ...graph, nodes: graph.nodes.slice().reverse() });
  assert.deepEqual(a.stars.map((s) => [s.node.id, s.style, s.k]).sort(), b.stars.map((s) => [s.node.id, s.style, s.k]).sort());
  assert.ok(new Set(a.stars.map((s) => s.style)).size >= 4, 'a map of one kind of star');
  assert.ok(starSize(9) > starSize(1) && starSize(1) > starSize(0));
  assert.equal(starStyle('anything', 12), STAR_GIANT);
  assert.ok(a.stars.filter((s) => s.style === STAR_PULSAR).length < a.stars.length * 0.1, 'pulsars are rare');
  const distances = a.constellations.filter((c) => !c.core).map((c) => Math.min(...a.constellations.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z))));
  assert.ok(Math.max(...distances) - Math.min(...distances) > 20, 'neighbours stand at different distances');
});

test('a brand new project during a session leaves every place where it was', () => {
  const graph = syntheticGraph(173, names);
  const slots = new Slots();
  const before = layoutUniverse(graph, slots);
  const extra = { id: 'new-1', title: 'new', file: 'new.md', project: 'brand-new', connected: true, degree: 0, live: false, mtime: 0, summary: null, issues: [] };
  const after = layoutUniverse({ ...graph, nodes: [...graph.nodes, extra] }, slots);
  for (const c of before.constellations) {
    const d = after.constellations.find((x) => x.key === c.key)!;
    assert.deepEqual([d.x, d.z], [c.x, c.z], `${c.key} moved`);
  }
  const fresh = after.constellations.find((c) => c.key === 'brand-new')!;
  for (const c of before.constellations) assert.ok(Math.hypot(c.x - fresh.x, c.z - fresh.z) > c.r + fresh.r, `new project lands on ${c.key}`);
  assert.ok(R > 0);
});

test('links stay real: only given edges, cross-project ones are marked', () => {
  const graph = syntheticGraph(100, names);
  const crossNodes = graph.nodes.filter((n) => n.project !== graph.nodes[0].project);
  const edges: [string, string][] = [...graph.edges, [graph.nodes[0].id, crossNodes[0].id], ['n0', 'does-not-exist']];
  const l = layoutUniverse({ ...graph, edges });
  assert.equal(l.links.length, edges.length - 1);
  assert.ok(l.links.some((x) => x.cross));
});

test('the core sits at the centre and holds this project and the global notes', () => {
  const graph = syntheticGraph(173, names);
  graph.coreProject = 'gamma';
  graph.nodes[0].project = null;
  const l = layoutUniverse(graph);
  const core = l.constellations.find((c) => c.core)!;
  assert.equal(core.key, 'gamma');
  assert.deepEqual([core.x, core.z], [0, 0]);
  assert.ok(core.stars.some((i) => l.stars[i].node.id === graph.nodes[0].id), 'global note in the core');
  assert.equal(l.constellations.filter((c) => c.core).length, 1);
  assert.ok(!l.constellations.some((c) => c.key === null));
});

test('the skeleton spans every cluster, stays apart from the links and changes no count', () => {
  const graph = syntheticGraph(173, names);
  const l = layoutUniverse(graph);
  const pair = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const real = new Set(l.links.map((x) => pair(x.a, x.b)));
  for (const [a, b] of l.skeleton) {
    assert.ok(!real.has(pair(a, b)), 'a skeleton line duplicates a real link');
    assert.equal(l.stars[a].c, l.stars[b].c, 'a skeleton line leaves its cluster');
  }
  assert.equal(l.links.length, graph.edges.length, 'only real links are links');
  const degree = new Map(graph.nodes.map((n) => [n.id, n.degree]));
  for (const s of l.stars) assert.equal(s.node.degree, degree.get(s.node.id));
});

test('the central star has the middle to itself and each group of a cluster hangs on it', () => {
  const graph = syntheticGraph(400, names);
  const l = layoutUniverse(graph);
  for (const [k, c] of l.constellations.entries()) {
    if (c.core) continue;
    const near = Math.min(...c.stars.map((i) => Math.hypot(l.stars[i].x - c.x, l.stars[i].z - c.z)));
    assert.ok(near >= c.r * 0.09, `${c.key}: a note ${near} from the central star of a cluster of ${c.r}`);
    assert.ok(l.spokes.some(([owner]) => owner === k), `${c.key} has no spokes`);
  }
  for (const [k, star] of l.spokes) assert.equal(l.stars[star].c, k, 'a spoke leaves its cluster');
  assert.equal(l.links.length, graph.edges.length, 'spokes are not links');
});

test('a hub with a hundred leaves is an even disc, not a ring', () => {
  const nodes = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: `s${i}`, file: `s${i}.md`, project: 'solo', connected: true, degree: i ? 1 : 100, live: false, mtime: 0, summary: null, issues: [] }));
  const edges = nodes.slice(1).map((n): [string, string] => ['s0', n.id]);
  const l = layoutUniverse({ nodes, edges, coreProject: null });
  const c = l.constellations.find((x) => x.key === 'solo')!;
  const far = c.stars.map((i) => Math.hypot(l.stars[i].x - c.x, l.stars[i].z - c.z) / c.r);
  const inner = far.filter((d) => d < 0.6).length;
  assert.ok(inner > 20 && inner < 80, `${inner} of 101 in the inner part`);
  for (const a of l.stars) {
    const gap = Math.min(...l.stars.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.z - b.z)));
    assert.ok(gap > 1.5, `two notes ${gap} apart`);
  }
});

test('a live project without notes keeps a stable place of its own', () => {
  const place = (key: string, slots = new Slots()) => constellationAt(key, false, slots);
  assert.deepEqual(place('solo'), place('solo'));
  const slots = new Slots();
  assert.notDeepEqual([place('solo', slots).x, place('solo', slots).z], [place('other', slots).x, place('other', slots).z]);
});
