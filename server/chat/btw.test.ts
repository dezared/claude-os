// /btw and the terminal handoff against the real server with the fake CLI. wt.exe is a script here: nothing opens on Windows.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BtwEvent, Tab, TerminalPreview } from '../../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from './fixtures/harness.ts';
import { btwArgs } from './btw.ts';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
type Logged = { kind: string; pid: number; argv: string[] };

const binDir = mkdtempSync(join(tmpdir(), 'claude-os-wt-'));
const wtLog = join(binDir, 'wt.log');
writeFileSync(join(binDir, 'wt.exe'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${wtLog}"\n`);
chmodSync(join(binDir, 'wt.exe'), 0o755);
const wtLines = () => (existsSync(wtLog) ? readFileSync(wtLog, 'utf8').trim().split('\n') : []);
const env = { PATH: `${binDir}:${process.env.PATH}` };
after(() => rmSync(binDir, { recursive: true, force: true }));

// Stands in for a terminal holding a session: an entry of the CLI's registry with a pid that is really alive.
function holdInRegistry(srv: TestServer, sessionId: string, cwd: string): () => void {
  const dir = join(srv.configDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const file = join(dir, `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, procStart, sessionId, cwd, status: 'idle', kind: 'interactive', updatedAt: Date.now() }));
  return () => rmSync(file, { force: true });
}

function journalOf(srv: TestServer, cwd: string, id: string) {
  return join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}

async function ask(srv: TestServer, tabId: string, question: string, signal?: AbortSignal) {
  const cookie = `claude_os=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`;
  return fetch(`http://127.0.0.1:${srv.port}/api/tabs/${tabId}/btw`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ question }), signal });
}

async function answerOf(res: Response): Promise<{ text: string; error: string | null | undefined }> {
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as BtwEvent);
  const last = events.at(-1)!;
  return { text: events.flatMap((e) => ('text' in e ? [e.text] : [])).join(''), error: 'done' in last ? last.error : undefined };
}

const prints = (srv: TestServer) => srv.log().filter((l) => l.kind === 'print') as unknown as Logged[];
const spawns = (srv: TestServer) => srv.log().filter((l) => l.kind === 'spawn') as unknown as Logged[];

it('/btw gets the profile block after its own prompt', () => {
  const prompt = (args: string[]) => args[args.indexOf('--append-system-prompt') + 1];
  const withProfile = prompt(btwArgs(null, null, 'id', { profile: '# The user\nReply in Russian (ru).' }));
  assert.match(withProfile, /quick side question[\s\S]*\n\n# The user\nReply in Russian \(ru\)\.$/);
  assert.doesNotMatch(prompt(btwArgs(null, null, 'id', { profile: '' })), /# The user|\n\n$/);
});

it('btw args carry the isolation settings', () => {
  const settings = (args: string[]) => args[args.indexOf('--settings') + 1];
  const iso = { claudeMdExcludes: ['/r/CLAUDE.md'], skillOverrides: {}, permissions: { deny: [] } };
  const parsed = JSON.parse(settings(btwArgs(null, null, 'id', { isolation: iso })));
  assert.equal(parsed.disableAllHooks, true);
  assert.deepEqual(parsed.claudeMdExcludes, ['/r/CLAUDE.md']);
  assert.equal(settings(btwArgs(null, null, 'id')), '{"disableAllHooks":true}');
});

describe('/btw', () => {
  let srv: TestServer;
  let workDir: string;
  before(async () => {
    srv = await startServer(env);
    workDir = mkdtempSync(join(srv.dir, 'w-'));
  });
  after(() => srv.destroy());

  it('during a running turn: answers from a copy, the turn, its process and its journal stay as they are', async () => {
    const client = await srv.connect();
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
    client.subscribe(tab.id);
    await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'SLOW' });
    await waitUntil(async () => !!(await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)?.sessionId, 'session id');
    const sessionId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.sessionId!;
    const main = spawns(srv).at(-1)!;
    const spawned = spawns(srv).length;
    const journal = readFileSync(journalOf(srv, workDir, sessionId), 'utf8');

    for (const q of ['первый вопрос', '- второй, с дефисом']) {
      const { text, error } = await answerOf(await ask(srv, tab.id, q));
      assert.equal(text, `side: ${q}`);
      assert.equal(error, null);
    }

    const flags = prints(srv).at(-1)!.argv;
    for (const f of ['--resume', sessionId, '--fork-session', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--tools', 'Read', '--strict-mcp-config']) assert.ok(flags.includes(f), f);
    assert.equal(flags.includes('- второй, с дефисом'), false, 'the question goes through stdin');

    assert.equal(spawns(srv).length, spawned, 'no new tab process');
    assert.ok(alive(main.pid), 'the main process lives');
    assert.equal(readFileSync(journalOf(srv, workDir, sessionId), 'utf8'), journal, 'the journal did not change');
    assert.equal(JSON.stringify(client.events(tab.id)).includes('side:'), false, 'nothing reached the chat');
    const history = JSON.stringify((await srv.api('GET', `/api/tabs/${tab.id}/history`)).body);
    assert.equal(history.includes('side:'), false);
    assert.equal(history.includes('первый вопрос'), false);
    const tabNow = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
    assert.equal(tabNow.status, 'working', 'the turn is still going');
    const ids = (await srv.api<{ id: string }[]>('GET', '/api/sessions')).body.map((s) => s.id);
    assert.equal(ids.includes(flags[flags.indexOf('--session-id') + 1]), false, 'the copy is no session of the list');

    await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
    await client.waitEvent(tab.id, 'result');
    await client.close();
  });

  it('closing the request kills the child, the tab does not notice', async () => {
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
    const abort = new AbortController();
    const count = prints(srv).length;
    const res = await ask(srv, tab.id, 'BTWHOLD', abort.signal);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    assert.match((await reader.read()).value!, /начало ответа/);
    const child = prints(srv)[count];
    assert.ok(alive(child.pid));
    abort.abort();
    await waitUntil(() => !alive(child.pid), 'the child is gone');
    assert.equal((await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)?.status, 'idle');
  });

  it('with no session yet it is a plain one-shot, and leaves no journal', async () => {
    const dir = mkdtempSync(join(srv.dir, 'fresh-'));
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: dir })).body;
    const { text } = await answerOf(await ask(srv, tab.id, 'вопрос'));
    assert.equal(text, 'plain: вопрос');
    const flags = prints(srv).at(-1)!.argv;
    assert.equal(flags.includes('--resume'), false);
    assert.equal(flags.includes('--fork-session'), false);
    assert.equal(existsSync(join(srv.configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))), false);
  });

  it('failures reach the card; an empty question is refused', async () => {
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
    assert.match((await answerOf(await ask(srv, tab.id, 'BTWCRASH'))).error!, /fake side crash/);
    assert.match((await answerOf(await ask(srv, tab.id, 'BTWFAIL'))).error!, /fake side failure/);
    assert.equal((await ask(srv, tab.id, '   ')).status, 400);
  });
});

describe('terminal handoff', () => {
  let srv: TestServer;
  let workDir: string;
  const IDLE_MS = 300;
  before(async () => {
    srv = await startServer({ ...env, CLAUDE_OS_TAB_IDLE_MS: String(IDLE_MS) });
    workDir = mkdtempSync(join(srv.dir, 'w-'));
  });
  after(() => srv.destroy());

  const preview = async (sessionId: string) => (await srv.api<TerminalPreview>('GET', `/api/open-terminal/preview?cwd=${encodeURIComponent(workDir)}&sessionId=${sessionId}`)).body;
  const run = async (sessionId: string) => (await srv.api<{ fork?: boolean; command?: string }>('POST', '/api/actions/builtin:terminal/run', { cwd: workDir, sessionId })).body;

  // A tab with a conversation whose process has just gone idle and ended.
  async function idleTab() {
    const client = await srv.connect();
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
    client.subscribe(tab.id);
    await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'one' });
    await client.waitEvent(tab.id, 'result');
    const sessionId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.sessionId!;
    await waitUntil(() => !alive(spawns(srv).at(-1)!.pid), 'the idle process stopped');
    return { client, tab, sessionId };
  }

  it('a live tab gets a copy, an idled one too; the shown command is what runs', async () => {
    const client = await srv.connect();
    const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
    client.subscribe(tab.id);
    await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'SLOW' });
    await waitUntil(async () => !!(await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)?.sessionId, 'session id');
    const sessionId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.sessionId!;

    const seen = await preview(sessionId);
    assert.equal(seen.fork, true);
    assert.equal(seen.holder, 'tab');
    const ran = await run(sessionId);
    assert.equal(ran.fork, true);
    assert.equal(ran.command, seen.command);
    await waitUntil(() => wtLines().some((l) => l.includes(sessionId)), 'wt.exe started');
    assert.match(wtLines().find((l) => l.includes(sessionId))!, new RegExp(`--resume ${sessionId} --fork-session$`));

    await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
    await client.waitEvent(tab.id, 'result');
    await waitUntil(() => !alive(spawns(srv).at(-1)!.pid), 'the idle process stopped');

    const later = await preview(sessionId);
    assert.equal(later.holder, null);
    assert.equal(later.fork, true, 'the terminal must not lock the idle tab out of its session');
    assert.equal(later.command.includes('--fork-session'), true);
    assert.equal((await run(sessionId)).fork, true);

    await srv.api('DELETE', `/api/tabs/${tab.id}`);
    assert.equal((await preview(sessionId)).fork, false, 'no tab, no process: the session itself');
    await client.close();
  });

  it('a tab idled out while a terminal copy is open: the next message respawns on its own session', async () => {
    const { client, tab, sessionId } = await idleTab();
    const release = holdInRegistry(srv, '99999999-9999-4999-8999-999999999999', workDir);
    try {
      const count = spawns(srv).length;
      const sent = await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'two' });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('two'));
      assert.ok(spawns(srv)[count].argv.join(' ').includes(`--resume=${sessionId}`), spawns(srv)[count].argv.join(' '));
    } finally {
      release();
      await client.close();
    }
  });

  it('a terminal on the same session: the tab refuses at once, spawns nothing, works again when it closes', async () => {
    const { client, tab, sessionId } = await idleTab();
    const count = spawns(srv).length;
    const release = holdInRegistry(srv, sessionId, workDir);
    try {
      // No waiting for the journal's list to catch up: the check itself reads the registry.
      const refused = await srv.api<{ error: string }>('POST', `/api/tabs/${tab.id}/send`, { text: 'two' });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, new RegExp(`still alive \\(pid ${process.pid}\\)`));
      assert.equal(spawns(srv).length, count);

      const seen = await preview(sessionId);
      assert.equal(seen.fork, true, 'a second terminal gets a copy too');
      assert.equal(seen.holder, 'terminal');
      assert.equal((await srv.api('POST', '/api/tabs', { resumeSessionId: sessionId })).status, 409);
    } finally {
      release();
    }
    await waitUntil(async () => (await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'two' })).status === 200, 'the tab is free again');
    await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('two'));
    await client.close();
  });

  it('a read-only tab: a copy while the terminal runs, the session itself once it ended', async () => {
    const { client, tab, sessionId } = await idleTab();
    const release = holdInRegistry(srv, sessionId, workDir);
    await waitUntil(async () => (await srv.api<{ id: string; status: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === sessionId && s.status !== 'ended'), 'seen live', 15_000);
    const readonly = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: sessionId, readonly: true });
    assert.equal(readonly.body.kind, 'readonly');
    await srv.api('DELETE', `/api/tabs/${tab.id}`);
    assert.equal((await preview(sessionId)).fork, true);
    release();
    await waitUntil(async () => !(await preview(sessionId)).fork, 'the session ended', 15_000);
    await client.close();
  });

  it('/branch: a copy of the journal in a new tab, the source stays and no process starts', async () => {
    const { client, tab, sessionId } = await idleTab();
    const source = readFileSync(journalOf(srv, workDir, sessionId), 'utf8');
    const count = spawns(srv).length;
    const res = await srv.api<Tab>('POST', `/api/tabs/${tab.id}/branch`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.sessionId, sessionId);
    assert.equal(res.body.kind, 'work');
    assert.ok(existsSync(journalOf(srv, workDir, res.body.sessionId!)));
    assert.equal(readFileSync(journalOf(srv, workDir, sessionId), 'utf8'), source);
    assert.equal(spawns(srv).length, count);

    client.subscribe(res.body.id);
    await srv.api('POST', `/api/tabs/${res.body.id}/send`, { text: 'в ветке' });
    await client.waitEvent(res.body.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('в ветке'));
    assert.ok(spawns(srv).at(-1)!.argv.join(' ').includes(`--resume=${res.body.sessionId}`));
    await client.close();
  });
});
