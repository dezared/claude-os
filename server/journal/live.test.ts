// Which processes are ours to end: a pid alone is not enough, and a machine without /proc must not stop a restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { childOf, claudeChildren, endClaudeChildren, endProcess, procStartOf, sameProcess, type RegistryEntry } from './live.ts';

const FAKE = join(import.meta.dirname, '../chat/fixtures/fake-claude.mjs');
const alive = (pid: number) => procStartOf(pid) !== null;
const entry = (pid: number, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({ pid, sessionId: 's', cwd: '/x', procStart: '100', ...extra });

describe('own processes', () => {
  it('a terminal entry with a foreign parent is never taken for our child', () => {
    const registry = [entry(1), entry(2, { sessionId: 'other' })];
    assert.equal(childOf(registry, 's', 42, () => '100', () => 7), null);
    assert.deepEqual(childOf(registry, 's', 42, () => '100', () => 42), { pid: 1, procStart: '100' });
    assert.equal(childOf(registry, 's', 42, () => '999', () => 42), null, 'a dead or reused pid is not the entry\'s process');
  });

  it('a reused pid with another start time is not killed', async () => {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const ref = { pid: other.pid!, procStart: 'not-its-start' };
      assert.equal(sameProcess(ref), false);
      await endProcess(ref, 100);
      assert.ok(alive(other.pid!));
      const real = { pid: other.pid!, procStart: procStartOf(other.pid!)! };
      assert.ok(sameProcess(real));
      await endProcess(real, 100);
      assert.equal(sameProcess(real), false);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('without /proc there are no children to end, and ending them still resolves', async () => {
    assert.deepEqual(claudeChildren(process.pid, '/nonexistent-proc'), []);
    await endClaudeChildren(process.pid, '/nonexistent-proc');
  });

  it('ends a claude child that ignores SIGTERM, and leaves other children alone', async () => {
    const claude = spawn(process.execPath, [FAKE, '--output-format', 'stream-json'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FAKE_CLAUDE_LINGER_MS: '60000' } });
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !claudeChildren(process.pid).includes(claude.pid!); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(claudeChildren(process.pid).includes(claude.pid!));
      await new Promise((r) => setTimeout(r, 300)); // its SIGTERM handler is in place
      await endClaudeChildren(process.pid, '/proc', 300);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(claude.pid!), false);
      assert.ok(alive(other.pid!));
    } finally {
      claude.kill('SIGKILL');
      other.kill('SIGKILL');
    }
  });
});
