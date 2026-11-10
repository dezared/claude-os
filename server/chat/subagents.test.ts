// Running subagents as the journal shows them: temp dirs only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listActiveSubagents } from './subagents.ts';

const claudeDir = mkdtempSync(join(tmpdir(), 'claude-os-subagents-'));
after(() => rmSync(claudeDir, { recursive: true, force: true }));
const cwd = '/home/test/project';
const SESSION = 'aaaaaaaa-0000-0000-0000-000000000000';
const dir = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const agents = join(dir, SESSION, 'subagents');
mkdirSync(join(agents, 'nested'), { recursive: true });
writeFileSync(join(dir, `${SESSION}.jsonl`), '{}\n');

const T0 = '2026-11-06T10:00:00.000Z';
const user = JSON.stringify({ type: 'user', timestamp: T0, message: { role: 'user', content: 'go' } });
const tool = (name: string, input: object, stop: string | null = null) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }], stop_reason: stop } });
const words = (stop: string | null) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'итог' }], stop_reason: stop } });

function agent(id: string, lines: string[], meta: object | null = { agentType: 'Explore', description: 'Ищет', toolUseId: `toolu_${id}` }, folder = agents) {
  writeFileSync(join(folder, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  if (meta) writeFileSync(join(folder, `agent-${id}.meta.json`), JSON.stringify(meta));
  return join(folder, `agent-${id}.jsonl`);
}

test('a fresh journal without a mark of the end is at work, with its last call and the time it started', () => {
  agent('a1', [user, tool('Read', { file_path: '/x/a.ts' }), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }), tool('Bash', { command: 'npm test\nsecond line' })]);
  const [a] = listActiveSubagents(SESSION, cwd, claudeDir);
  assert.equal(a.id, 'a1');
  assert.equal(a.toolUseId, 'toolu_a1');
  assert.equal(a.agentType, 'Explore');
  assert.equal(a.description, 'Ищет');
  assert.equal(a.doing, 'Bash npm test');
  assert.equal(a.startedAt, Date.parse(T0));
});

test('a mark on the meta file, a final message and a long silence all mean it stopped; nesting and a missing meta do not matter', () => {
  agent('done', [user, tool('Bash', { command: 'x' })], { finished: true });
  agent('said', [user, tool('Bash', { command: 'x' }), words('end_turn')]);
  const silent = agent('silent', [user, tool('Bash', { command: 'x' })]);
  const old = new Date(Date.now() - 121_000);
  utimesSync(silent, old, old);
  agent('deep', [user, words(null)], null, join(agents, 'nested'));
  const ids = listActiveSubagents(SESSION, cwd, claudeDir).map((a) => a.id).sort();
  assert.deepEqual(ids, ['a1', 'deep']);
  const deep = listActiveSubagents(SESSION, cwd, claudeDir).find((a) => a.id === 'deep')!;
  assert.equal(deep.agentType, null);
  assert.equal(deep.doing, null, 'no call yet: nothing is invented');
});

test('a huge journal: only its end is read, a line cut by the window is skipped', () => {
  agent('big', [user, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200_000) } }), tool('Grep', { pattern: 'нужное' })]);
  assert.equal(listActiveSubagents(SESSION, cwd, claudeDir).find((a) => a.id === 'big')!.doing, 'Grep нужное');
});

test('a journal is read again only after it or its meta changed, and silence still counts by the clock', () => {
  const path = agent('cached', [user, tool('Read', { file_path: '/x/one.ts' })]);
  const find = (now?: number) => listActiveSubagents(SESSION, cwd, claudeDir, now).find((a) => a.id === 'cached');
  const at = new Date(Date.now() - 1000); // whole milliseconds, so that setting it again gives the very same time
  utimesSync(path, at, at);
  assert.equal(find()!.doing, 'Read /x/one.ts');

  // Other bytes of the same length, the same times: the cache is what answers.
  const { size } = statSync(path);
  writeFileSync(path, readFileSync(path, 'utf8').replace('one.ts', 'two.ts'));
  utimesSync(path, at, at);
  assert.equal(statSync(path).size, size);
  assert.equal(find()!.doing, 'Read /x/one.ts');

  assert.equal(find(at.getTime() + 121_000), undefined, 'silent for too long, cached or not');

  writeFileSync(path, [user, tool('Bash', { command: 'ls' })].join('\n') + '\n');
  assert.equal(find()!.doing, 'Bash ls');
  writeFileSync(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ finished: true }));
  assert.equal(find(), undefined, 'the mark on the meta file is seen at once');
});

test('measure: 50 live sessions of 20 subagents each, the first pass and the repeated one', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, '0')}`);
  for (const id of ids) {
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
    const folder = join(dir, id, 'subagents');
    mkdirSync(folder, { recursive: true });
    for (let n = 0; n < 20; n++) agent(`m${n}`, [user, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(70_000) } }), tool('Read', { file_path: '/x' })], undefined, folder);
  }
  const pass = () => {
    const at = performance.now();
    const running = ids.reduce((sum, id) => sum + listActiveSubagents(id, cwd, claudeDir).length, 0);
    assert.equal(running, 1000);
    return performance.now() - at;
  };
  const first = pass();
  const repeated = Math.min(pass(), pass(), pass());
  console.log(`active subagents, 1000 journals: first pass ${first.toFixed(1)} ms, repeated ${repeated.toFixed(1)} ms`);
  assert.ok(repeated < first, `${repeated} < ${first}`);
});

test('a session without a journal has nothing running', () => {
  assert.deepEqual(listActiveSubagents('nope', cwd, claudeDir), []);
});
