// The pure parts of the search by meaning: the vector store and the fusion with FTS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchHit } from '../search.ts';
import { fuse } from './fuse.ts';
import { createVectors, loadVectors } from './vectors.ts';

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v, (x) => x / n);
};
const hit = (id: string): SearchHit => ({ id, path: `/${id}.md`, project: null, type: null, name: id, description: null, snippet: '' });

test('vectors: the nearest first, a project filter, replace and remove', () => {
  const vs = createVectors(3);
  vs.set({ path: '/a', sha: 's1', project: 'p' }, unit(1, 0, 0));
  vs.set({ path: '/b', sha: 's1', project: 'q' }, unit(1, 1, 0));
  vs.set({ path: '/c', sha: 's1', project: 'p' }, unit(0, 0, 1));
  assert.deepEqual(vs.top(unit(1, 0.2, 0), 2, null).map((h) => h.path), ['/a', '/b']);
  assert.deepEqual(vs.top(unit(1, 1, 0), 5, 'p').map((h) => h.path), ['/a', '/c']);
  assert.ok(Math.abs(vs.top(unit(1, 0, 0), 1, null)[0].score - 1) < 0.01, 'int8 keeps the cosine close');
  vs.set({ path: '/a', sha: 's2', project: 'p' }, unit(0, 0, 1));
  assert.equal(vs.get('/a')?.sha, 's2');
  assert.equal(vs.size(), 3);
  vs.remove('/c');
  assert.equal(vs.size(), 2);
  assert.deepEqual(vs.top(unit(0, 0, 1), 5, null).map((h) => h.path), ['/a', '/b']);
});

test('vectors: the top in turns equals the top at once, across many turns', async () => {
  const vs = createVectors(3);
  for (let i = 0; i < 25_000; i++) vs.set({ path: `/n${i}`, sha: 's', project: i % 3 ? 'p' : 'q' }, unit(Math.sin(i), Math.cos(i * 7), (i % 11) / 10));
  for (const project of [null, 'q']) {
    const q = unit(0.3, -0.5, 0.8);
    assert.deepEqual(await vs.topLater(q, 20, project), vs.top(q, 20, project));
  }
});

test('vectors: a saved store loads back the same; a file of another model or size loads empty', () => {
  const vs = createVectors(3);
  for (let i = 0; i < 40; i++) vs.set({ path: `/n${i}`, sha: `s${i}`, project: i % 2 ? 'p' : null }, unit(1, i, 40 - i));
  vs.remove('/n3');
  const back = loadVectors(vs.serialize('m'), 'm', 3);
  assert.equal(back.size(), 39);
  assert.deepEqual(back.get('/n7'), { path: '/n7', sha: 's7', project: 'p' });
  assert.deepEqual(back.top(unit(1, 7, 33), 3, null), vs.top(unit(1, 7, 33), 3, null));
  assert.equal(loadVectors(vs.serialize('m'), 'other', 3).size(), 0);
  assert.equal(loadVectors(vs.serialize('m'), 'm', 4).size(), 0);
  assert.equal(loadVectors(Buffer.from('junk'), 'm', 3).size(), 0);
});

test('fuse: reciprocal rank fusion, FTS first on a tie, the limit kept', () => {
  const fts = [hit('a'), hit('b'), hit('c')];
  const sem = [hit('x'), hit('b'), hit('a')];
  assert.deepEqual(fuse(fts, sem, 3).map((h) => h.id), ['a', 'b', 'x'], 'found by both outranks found by one');
  assert.deepEqual(fuse(fts, [], 2).map((h) => h.id), ['a', 'b'], 'no vectors: FTS alone, as it was');
  assert.deepEqual(fuse([], sem, 5).map((h) => h.id), ['x', 'b', 'a']);
  assert.equal(fuse(fts, sem, 3)[0], fts[0], 'the FTS hit, with its marked snippet, wins over the same note found by meaning');
});
