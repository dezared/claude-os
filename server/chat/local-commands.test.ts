// /clear, the panel's reset, /rc and screen-only commands: answered by Claude OS, over the fake claude. No tokens.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ChatEvent, Tab } from '../../shared/contract.ts';
import { toCommandInfo } from '../tools/commands.ts';
import { startServer, waitUntil, type Client, type TestServer } from './fixtures/harness.ts';
import { slashCommands } from './translate.ts';

describe('commands Claude OS answers itself', () => {
  let srv: TestServer;
  let client: Client;
  let workDir: string;

  before(async () => {
    srv = await startServer({ CLAUDE_OS_PTY_SETTLE_MS: '400', CLAUDE_OS_TAB_IDLE_MS: '300' });
    client = await srv.connect();
    workDir = join(srv.dir, 'work');
    mkdirSync(workDir);
  });
  after(async () => {
    await client.close();
    await srv.destroy();
  });

  const newTab = async (): Promise<Tab> => {
    const res = await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir });
    client.subscribe(res.body.id);
    return res.body;
  };
  const send = (id: string, text: string) => srv.api('POST', `/api/tabs/${id}/send`, { text });
  const spawns = () => srv.log().filter((l) => l.kind === 'spawn') as { argv: string[]; pid: number }[];
  const results = (id: string) => client.events(id).filter((e) => e.e === 'result').length;
  const history = async (id: string) => (await srv.api<ChatEvent[]>('GET', `/api/tabs/${id}/history`)).body;
  const tabOf = async (id: string) => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === id)!;
  const turn = async (id: string, text: string) => {
    const before = results(id);
    assert.equal((await send(id, text)).status, 200);
    await waitUntil(() => results(id) > before, `turn "${text}"`);
  };

  it('classifies: screens go to the background route, /rc is ours, real dialogs stay in the terminal', () => {
    const by = Object.fromEntries(slashCommands(['usage', 'mcp', 'rc', 'remote-control', 'config', 'output-style', 'bound'], ['rc', 'bound']).map((c) => [c.name, c.needsTerminal]));
    assert.deepEqual(by, { usage: false, mcp: false, rc: false, 'remote-control': false, config: true, 'output-style': true, bound: true });
    const menu = toCommandInfo([{ name: 'compact', description: '' }], [], []);
    assert.equal(menu.find((c) => c.name === 'rc')?.needsTerminal, false);
    assert.equal(toCommandInfo([{ name: 'remote-control', description: '' }], [], []).some((c) => c.name === 'rc'), false, 'not twice');
  });

  it('classifies /doctor as off the chat: a model turn must not run in an invisible terminal', async () => {
    assert.deepEqual(slashCommands(['doctor', 'focus'], ['doctor', 'focus']), [{ name: 'doctor', needsTerminal: true }, { name: 'focus', needsTerminal: false }]);
    const tab = await newTab();
    const users = srv.log().filter((l) => l.kind === 'user').length;
    await turn(tab.id, '/doctor');
    assert.equal(srv.log().filter((l) => l.kind === 'tui' && (l.argv as string[]).includes('/doctor')).length, 0, 'no background terminal for it');
    assert.equal(srv.log().filter((l) => l.kind === 'user').length, users + 1, 'if a client sends it anyway, it is a plain message');
  });

  it('the menu keeps what the CLI hides from SDK sessions, marked, and a skill of that name wins', () => {
    const menu = toCommandInfo([{ name: 'plan', description: 'My own skill', argumentHint: '' }], [], []);
    const by = Object.fromEntries(menu.map((c) => [c.name, c]));
    assert.equal(by.login.needsTerminal, true);
    assert.equal(by.login.source, 'builtin');
    assert.equal(by.login.description, 'Sign in with your Anthropic account');
    assert.equal(by.plan.needsTerminal, false, 'the skill stays');
    assert.equal(by.plan.description, 'My own skill');
    assert.equal(by.focus.needsTerminal, false);
    assert.equal(by.focus.argumentHint, '[on|off]');
    assert.equal(menu.filter((c) => c.name === 'focus').length, 1);
    assert.equal(toCommandInfo([{ name: 'focus', description: 'CLI text', argumentHint: '[on|off]' }], [], ['focus']).filter((c) => c.name === 'focus').length, 1, 'not twice');
    assert.equal(by.view.needsTerminal, false);
    assert.equal(by.view.source, 'builtin');
    assert.equal(by.view.argumentHint, '[default|large|full]');
    assert.equal(toCommandInfo([{ name: 'view', description: 'CLI text' }], [], ['view']).filter((c) => c.name === 'view' && !c.needsTerminal).length, 1, 'not twice, never terminal-only');
  });

  it('POST /api/doctor runs `claude doctor` in a terminal and returns the screen, no session flags, no turn', async () => {
    const users = srv.log().filter((l) => l.kind === 'user').length;
    const spawned = spawns().length;
    const res = await srv.api<{ output: string; error: string | null }>('POST', '/api/doctor');
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null);
    assert.equal(res.body.output, 'Claude Code doctor\n\nRunning: native (2.1.318)\nNo installation issues found.');
    const tui = srv.log().filter((l) => l.kind === 'tui').at(-1) as { isTTY: boolean; argv: string[] };
    assert.deepEqual(tui.argv, ['doctor']);
    assert.equal(tui.isTTY, true);
    assert.equal(srv.log().filter((l) => l.kind === 'user').length, users);
    assert.equal(spawns().length, spawned, 'no session process');
  });

  it('/clear wipes the conversation, keeps the process and starts no turn', async () => {
    const tab = await newTab();
    await turn(tab.id, 'old words');
    const count = spawns().length;
    const old = (await tabOf(tab.id)).sessionId;
    assert.ok(old);

    assert.equal((await send(tab.id, ' /clear ')).status, 200);
    await client.waitEvent(tab.id, 'cleared');
    assert.equal((await tabOf(tab.id)).sessionId, null);
    assert.deepEqual((await history(tab.id)).map((e) => e.e), ['cleared']);

    await turn(tab.id, 'new words');
    assert.equal(spawns().length, count, 'the same process answers');
    const now = await history(tab.id);
    assert.ok(now.every((e) => JSON.stringify(e).indexOf('old words') < 0), 'old words are gone');
    assert.ok(now.some((e) => e.e === 'assistant'));
    const adopted = (await tabOf(tab.id)).sessionId;
    assert.ok(adopted && adopted !== old, 'the next init names the new session');
    assert.equal(client.events(tab.id).filter((e) => e.e === 'result' && e.usage.input === 0).length, 0, 'the answer to /clear is not shown');
  });

  it('/clear during a turn is refused, the turn goes on', async () => {
    const tab = await newTab();
    await send(tab.id, 'HOLD 400');
    await client.waitEvent(tab.id, 'user');
    assert.equal((await send(tab.id, '/clear')).status, 409);
    await client.waitEvent(tab.id, 'result');
  });

  it('reset stops the process and the next message starts a new session', async () => {
    const tab = await newTab();
    await turn(tab.id, 'to forget');
    assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/reset`)).status, 200);
    await client.waitEvent(tab.id, 'cleared');
    assert.deepEqual((await history(tab.id)).map((e) => e.e), ['cleared']);
    const count = spawns().length;
    await turn(tab.id, 'fresh start');
    assert.equal(spawns().length, count + 1);
    assert.equal(spawns().at(-1)!.argv.some((a) => a.startsWith('--resume')), false);
  });

  it('/rc asks the CLI over the control protocol, without a prompt, and holds the process', async () => {
    const tab = await newTab();
    const count = spawns().length;
    const users = srv.log().filter((l) => l.kind === 'user').length;
    assert.equal((await send(tab.id, '/rc')).status, 200);
    const on = await client.waitEvent(tab.id, 'assistant', (e) => JSON.stringify(e.blocks).includes('Remote Control is on'));
    assert.match(JSON.stringify(on.blocks), /https:\/\/claude\.ai\/code\/session_/);
    assert.equal(on.key, 'rcOnUrl');
    assert.match(String(on.params?.url), /^https:\/\/claude\.ai\/code\/session_/);
    assert.equal(spawns().length, count + 1, 'a process was started for it');
    assert.equal(srv.log().filter((l) => l.kind === 'user').length, users, 'no prompt, no tokens');
    const asked = () => srv.log().filter((l) => l.kind === 'control' && l.subtype === 'remote_control').map((l) => (l.request as { enabled: boolean }).enabled);
    assert.deepEqual(asked().slice(-1), [true]);

    // Longer than the idle limit of this server: the link is alive only while the process is.
    await new Promise((r) => setTimeout(r, 900));
    await turn(tab.id, 'still here');
    assert.equal(spawns().length, count + 1, 'the idle timer left it alone');

    await send(tab.id, '/remote-control');
    await client.waitEvent(tab.id, 'assistant', (e) => e.key === 'rcOff');
    assert.deepEqual(asked().slice(-2), [true, false]);
  });

  it('/usage runs in a real pseudo-terminal and the chat gets the rendered screen', async () => {
    const tab = await newTab();
    const users = srv.log().filter((l) => l.kind === 'user').length;
    assert.equal((await send(tab.id, '/usage')).status, 200);
    const done = await client.waitEvent(tab.id, 'terminal', (e) => e.done);
    assert.equal(done.command, '/usage');
    assert.equal(done.error, null);
    assert.equal(done.screen, 'Screen of /usage\n\n  Current session: 12% used', 'escape sequences are applied, not shown');
    // The colours come with it, over the text as the chat has it.
    assert.deepEqual(done.runs, [{ line: 0, from: 0, to: 16, bold: true }, { line: 2, from: 19, to: 22, fg: 114 }]);
    assert.equal(done.screen.split('\n')[2].slice(19, 22), '12%');
    const tui = srv.log().filter((l) => l.kind === 'tui').at(-1) as { isTTY: boolean; argv: string[]; cols: number };
    assert.equal(tui.isTTY, true);
    assert.equal(tui.cols, 90);
    assert.equal(tui.argv[0], '/usage');
    assert.ok(tui.argv.includes('{"disableAllHooks":true}'));
    assert.equal(srv.log().filter((l) => l.kind === 'user').length, users, 'no prompt, no tokens');

    // One card in the history, the last state of it; the throwaway session leaves no journal.
    assert.equal((await history(tab.id)).filter((e) => e.e === 'terminal').length, 1);
    const dir = join(srv.configDir, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const id = tui.argv[tui.argv.indexOf('--session-id') + 1];
    await waitUntil(() => !readdirSync(dir).includes(`${id}.jsonl`), 'the throwaway journal is removed');
  });

  it('colours keep to the characters past a wide one, and a background run is kept', async () => {
    const tab = await newTab();
    assert.equal((await send(tab.id, '/status')).status, 200);
    const done = await client.waitEvent(tab.id, 'terminal', (e) => e.done);
    const lines = done.screen.split('\n');
    const of = (n: number) => done.runs!.filter((r) => r.line === n).map((r) => lines[n].slice(r.from, r.to));
    const wide = lines.findIndex((l) => l.includes('日本語'));
    assert.deepEqual(of(wide), ['wide']);
    const bar = lines.findIndex((l) => l.includes('█'));
    assert.deepEqual(of(bar), ['█████     ']);
    assert.deepEqual(done.runs!.find((r) => r.line === bar)!.bg, 102);
  });

  it('a skill or a command with arguments still goes to Claude', async () => {
    const tab = await newTab();
    await turn(tab.id, '/usage please');
    assert.ok(srv.log().some((l) => l.kind === 'user' && l.content === '/usage please'));
  });

  it('the conversation is still there after a restart', async () => {
    const tab = await newTab();
    await turn(tab.id, 'remember me');
    await client.close();
    await srv.restart();
    client = await srv.connect();
    const events = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${tab.id}/history`)).body;
    assert.ok(events.some((e) => e.e === 'user' && JSON.stringify(e.blocks).includes('remember me')));
    assert.ok(events.some((e) => e.e === 'assistant' && JSON.stringify(e.blocks).includes('echo: remember me')));
  });
});

describe('/rc refused by the CLI', () => {
  it('shows why', async () => {
    const srv = await startServer({ FAKE_CLAUDE_RC_ERROR: 'Remote Control environments are not available for your account.' });
    const client = await srv.connect();
    try {
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: srv.dir })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: '/rc' });
      const error = await client.waitEvent(tab.id, 'error');
      assert.match(error.text, /Remote Control was not turned on: Remote Control environments are not available/);
      assert.equal(error.key, 'rcOnFailed');
    } finally {
      await client.close();
      await srv.destroy();
    }
  });
});
