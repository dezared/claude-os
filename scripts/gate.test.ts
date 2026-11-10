import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newSuppressions, runGate, type GateStep } from './gate.ts';

const step = (name: string): GateStep => ({ name, run: ['true'] });
const diffOf = (path: string, line: string) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,2 @@', ' const a = 1;', line].join('\n');

test('stops at the first red step', async () => {
  const ran: string[] = [];
  const result = await runGate([step('a'), step('b'), step('c')], async (s) => {
    ran.push(s.name);
    return { code: s.name === 'b' ? 1 : 0, output: `${s.name} out` };
  });
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(result.ok, false);
  assert.equal(result.failed, 'b');
});

test('reports only failing output', async () => {
  const result = await runGate([step('a'), step('b')], async (s) =>
    s.name === 'a' ? { code: 0, output: 'green noise' } : { code: 1, output: 'red detail' },
  );
  assert.equal(result.output, 'red detail');
  assert.doesNotMatch(result.output, /green noise/);
});

test('green when every step passes', async () => {
  const result = await runGate([step('a')], async () => ({ code: 0, output: 'x' }));
  assert.deepEqual(result, { ok: true, failed: null, output: '' });
});

test('flags an added ts-ignore line', () => {
  const hits = newSuppressions(diffOf('server/x.ts', '+// @ts-ignore'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /server\/x\.ts/);
});

test('ignores removed suppression lines', () => {
  assert.deepEqual(newSuppressions(diffOf('server/x.ts', '-// @ts-ignore')), []);
});

test("ignores suppression words in the gate's own files and markdown", () => {
  const diff = [diffOf('scripts/gate.ts', '+// @ts-ignore'), diffOf('docs/rules/code-style.md', '+// @ts-ignore')].join('\n');
  assert.deepEqual(newSuppressions(diff), []);
});

test('flags an added ts-nocheck line', () => {
  assert.equal(newSuppressions(diffOf('server/x.ts', '+// @ts-nocheck')).length, 1);
});
