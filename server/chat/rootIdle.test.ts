import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Tab } from '../../shared/contract.ts';
import { resetIdleRoot, rootIdleMs, ROOT_IDLE_RESET_HOURS } from './rootIdle.ts';

const HOUR = 3_600_000;
const dir = mkdtempSync(join(tmpdir(), 'cos-root-idle-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const config = join(dir, 'config');
const claudeDir = join(dir, 'claude');
const cwd = join(dir, 'root');
mkdirSync(config, { recursive: true });

function journal(sessionId: string, at: number): void {
  const folder = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${sessionId}.jsonl`);
  writeFileSync(file, '{}\n');
  utimesSync(file, at / 1000, at / 1000);
}

function fakeChat(tab: Partial<Tab>, held = 0, session: { working?: boolean; command?: boolean } = {}) {
  const resets: string[] = [];
  const root = { id: 'root-1', kind: 'root', cwd, sessionId: 's-1', status: 'idle', queued: 0, subagents: 0, ...tab } as Tab;
  return {
    resets,
    chat: {
      ctx: { paths: { config, claudeDir } },
      list: () => [root],
      get: (id: string) => ({ held: Array.from({ length: held }), reset: () => resets.push(id), working: () => !!session.working, stopBackground: session.command ? () => {} : null }),
    },
  };
}

const settings = (value: unknown) => writeFileSync(join(config, 'settings.json'), JSON.stringify(value));

describe('the root chat starts over after a long pause', () => {
  it('reads the threshold from settings, 24 hours by default, 0 turns it off', () => {
    settings({});
    assert.equal(rootIdleMs(config), ROOT_IDLE_RESET_HOURS * HOUR);
    assert.equal(ROOT_IDLE_RESET_HOURS, 24);
    settings({ rootChat: { idleResetHours: 2 } });
    assert.equal(rootIdleMs(config), 2 * HOUR);
    settings({ rootChat: { idleResetHours: 0 } });
    assert.equal(rootIdleMs(config), 0);
    settings({ rootChat: { idleResetHours: 'soon' } });
    assert.equal(rootIdleMs(config), 24 * HOUR, 'a value that does not fit falls back to the default');
    settings({ rootChat: { idleResetHours: -3 } });
    assert.equal(rootIdleMs(config), 24 * HOUR);
  });

  it('resets an idle conversation older than the threshold, and only that', () => {
    settings({});
    const now = Date.now();
    journal('s-1', now - 25 * HOUR);

    const old = fakeChat({});
    assert.equal(resetIdleRoot(old.chat, now), true);
    assert.deepEqual(old.resets, ['root-1']);

    const fresh = fakeChat({});
    assert.equal(resetIdleRoot(fresh.chat, now - 2 * HOUR), false, 'a day has not passed yet');

    for (const busy of [{ status: 'working' }, { status: 'waiting_permission' }, { queued: 1 }, { sessionId: null }] as Partial<Tab>[]) {
      const c = fakeChat(busy);
      assert.equal(resetIdleRoot(c.chat, now), false, JSON.stringify(busy));
      assert.deepEqual(c.resets, []);
    }
    const held = fakeChat({}, 1);
    assert.equal(resetIdleRoot(held.chat, now), false, 'messages held after a restart wait for the user');

    assert.equal(resetIdleRoot(fakeChat({ subagents: 1 }).chat, now), false, 'a subagent still at work');
    assert.equal(resetIdleRoot(fakeChat({}, 0, { working: true }).chat, now), false, 'a background task of the process');
    assert.equal(resetIdleRoot(fakeChat({}, 0, { command: true }).chat, now), false, 'a command running in the terminal');

    const lost = fakeChat({ sessionId: 's-missing' });
    assert.equal(resetIdleRoot(lost.chat, now), false, 'no journal: nothing tells how old it is');

    settings({ rootChat: { idleResetHours: 0 } });
    const off = fakeChat({});
    assert.equal(resetIdleRoot(off.chat, now), false, 'turned off');

    settings({});
    // A subagent wrote an hour ago: the conversation is not idle, though its own journal is a day old.
    const agent = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 's-1', 'subagents', 'workflows', 'w1', 'agent-a1.jsonl');
    mkdirSync(join(agent, '..'), { recursive: true });
    writeFileSync(agent, '{}\n');
    utimesSync(agent, (now - HOUR) / 1000, (now - HOUR) / 1000);
    assert.equal(resetIdleRoot(fakeChat({}).chat, now), false, 'the latest of the journal and its subagents counts');
    utimesSync(agent, (now - 30 * HOUR) / 1000, (now - 30 * HOUR) / 1000);
    assert.equal(resetIdleRoot(fakeChat({}).chat, now), true, 'an old subagent journal does not keep it');

    settings({ rootChat: { idleResetHours: 48 } });
    const longer = fakeChat({});
    assert.equal(resetIdleRoot(longer.chat, now), false, 'a longer threshold keeps it');
  });
});
