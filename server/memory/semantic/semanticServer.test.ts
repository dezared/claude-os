// The search by meaning end to end on the server, with the fake engine behind CLAUDE_OS_SEMANTIC_ENGINE.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { SemanticStatus } from '../../../shared/memorySemantic.ts';
import { registerMemory } from '../index.ts';
import { makeKit, type TestKit } from '../testkit.ts';

process.env.CLAUDE_OS_SEMANTIC_ENGINE = join(import.meta.dirname, 'fixtures/fake-engine.ts');

let kit: TestKit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.close());

const note = (file: string, description: string, body: string) =>
  kit.write(join(kit.paths.vault, 'projects', 'p', file), `---\nname: ${file.replace('.md', '')}\ndescription: ${description}\nmetadata:\n  type: project\n  tags: [infra]\n---\n${body}\n`);
const call = async <T>(method: 'GET' | 'POST' | 'DELETE', url: string) => {
  const res = await kit.app.inject({ method, url });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as T;
};
const status = () => call<SemanticStatus>('GET', '/api/memory/semantic');
const names = async (q: string) => (await kit.ctx.memory.find(q, { project: 'p' })).map((h) => h.name);

// Polls the status until it fits: the build runs in another process.
async function statusWhen(ok: (s: SemanticStatus) => boolean): Promise<SemanticStatus> {
  for (let i = 0; i < 300; i++) {
    const s = await status();
    if (ok(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`status did not settle: ${JSON.stringify(await status())}`);
}
const built = (n: number) => (s: SemanticStatus) => s.state === 'ready' && s.total === n && s.indexed === n;

async function enable(n: number) {
  await call('POST', '/api/memory/semantic/enable');
  return statusWhen(built(n));
}

test('search is FTS alone until the model is downloaded, then a note is found by a word it does not contain', async () => {
  note('parking.md', 'Where the car is parked', 'The car stays on level 3 of the garage.');
  note('redis.md', 'Redis eviction', 'Production Redis uses allkeys-lfu.');
  registerMemory(kit.ctx);
  assert.deepEqual(await names('машина'), [], 'no model: no hit by meaning, silently');
  assert.deepEqual(await names('redis'), ['redis']);
  const before = await status();
  assert.equal(before.state, 'off');
  assert.equal(before.enabled, true);

  const s = await enable(2);
  assert.ok(s.indexBytes > 0);
  assert.ok(existsSync(join(kit.paths.data, 'memory-semantic', 'vectors.bin')), 'the vectors are saved');
  assert.deepEqual((await names('машина'))[0], 'parking', 'a Russian word finds the English note');
  assert.deepEqual((await names('redis'))[0], 'redis', 'an FTS hit still leads');
  assert.ok(kit.audits.some((a) => a.action === 'memory.semantic.install'));
  assert.ok(kit.topics.includes('memorySemantic'));
});

test('a written note gets its vector; turning off falls back to FTS; removing deletes the model and the vectors', async () => {
  note('redis.md', 'Redis eviction', 'Production Redis uses allkeys-lfu.');
  registerMemory(kit.ctx);
  await enable(1);
  note('parking.md', 'Where the vehicle is parked', 'Level 3 of the garage.');
  await statusWhen(built(2)); // the watcher's change, then the debounce
  assert.equal((await names('automobile'))[0], 'parking', 'the new note is found by meaning');

  const off = await call<SemanticStatus>('POST', '/api/memory/semantic/disable');
  assert.equal(off.enabled, false);
  assert.deepEqual(await names('automobile'), []);
  const on = await call<SemanticStatus>('POST', '/api/memory/semantic/enable');
  assert.equal(on.enabled, true);

  const gone = await call<SemanticStatus>('DELETE', '/api/memory/semantic/model');
  assert.equal(gone.state, 'off');
  assert.equal(gone.indexed, 0);
  assert.equal(existsSync(join(kit.paths.data, 'memory-semantic')), false);
  assert.deepEqual(await names('automobile'), []);
});
