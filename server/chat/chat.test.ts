import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Analytics, ChatEvent, Tab } from '../../shared/contract.ts';
import { unifiedDiff } from './diff.ts';
import { procStartOf } from '../journal/live.ts';
import { Chat } from './manager.ts';
import { truncatedLines } from '../../web/src/lib/serverLines.ts';
import { startServer, waitUntil, type Client, type TestServer } from './fixtures/harness.ts';
import { projectDirFor } from './rootMcp.ts';
import { slashCommands } from './translate.ts';

describe('chat over the fake claude', () => {
  let srv: TestServer;
  let client: Client;
  let workDir: string;

  before(async () => {
    srv = await startServer();
    client = await srv.connect();
    workDir = join(srv.dir, 'work');
    mkdirSync(workDir);
  });
  after(async () => {
    await client.close();
    await srv.destroy();
  });

  async function newTab(extra: Record<string, unknown> = {}, cwd = workDir): Promise<Tab> {
    const res = await srv.api<Tab>('POST', '/api/tabs', { cwd, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    client.subscribe(res.body.id);
    return res.body;
  }
  const send = (id: string, text: string, attachments?: unknown[]) => srv.api('POST', `/api/tabs/${id}/send`, { text, attachments });
  const tabOf = async (id: string) => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === id)!;
  const spawns = () => srv.log().filter((l) => l.kind === 'spawn') as { argv: string[]; cwd: string }[];

  it('has a root tab that cannot be closed, with its role file', async () => {
    const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
    const root = tabs.find((t) => t.kind === 'root')!;
    assert.ok(root);
    assert.ok(existsSync(join(root.cwd, 'CLAUDE.md')));
    assert.equal((await srv.api('DELETE', `/api/tabs/${root.id}`)).status, 403);
  });

  it('streams a turn: user, init, delta, assistant, result, and marks status', async () => {
    const tab = await newTab();
    assert.equal((await send(tab.id, 'hello there')).status, 200);
    const result = await client.waitEvent(tab.id, 'result');
    const events = client.events(tab.id);
    assert.deepEqual(result.usage, { input: 10, output: 5, cacheWrite: 2, cacheRead: 3 });
    assert.equal(result.interrupted, false);
    const init = events.find((e) => e.e === 'init')!;
    assert.equal(init.e === 'init' && init.permissionMode, 'auto');
    const order = events.map((e) => e.e);
    assert.ok(order.indexOf('user') < order.indexOf('init'));
    assert.ok(order.indexOf('delta') < order.indexOf('assistant'));
    assert.ok(order.includes('status'));
    const deltas = events.flatMap((e) => (e.e === 'delta' ? [e.text] : [])).join('');
    assert.equal(deltas, 'echo: hello there');
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    await waitUntil(async () => (await tabOf(tab.id)).status === 'idle', 'idle');
    assert.ok((await tabOf(tab.id)).sessionId);
  });

  it('passes the agreed options and never picks a permission mode', async () => {
    const tab = await newTab({ model: 'fake-opus', effort: 'low' });
    await send(tab.id, 'options');
    await client.waitEvent(tab.id, 'result');
    const { argv, cwd } = spawns().at(-1)!;
    const joined = argv.join(' ');
    assert.equal(cwd, workDir);
    assert.match(joined, /--setting-sources[ =]user,project,local/);
    assert.ok(joined.includes(`Edit(//${srv.dataDir.slice(1)}/**)`), joined);
    assert.match(joined, /--model[ =]fake-opus/);
    assert.match(joined, /--effort[ =]low/);
    assert.match(joined, /--permission-prompt-tool[ =]stdio/);
    assert.doesNotMatch(joined, /--permission-mode|bypassPermissions|dangerously/);
    // A planner note and its pictures are read by path from any project.
    assert.ok(argv.includes(`--add-dir=${join(srv.dataDir, 'planner')}`), joined);
    assert.doesNotMatch(joined, /mcp__claude-os__(list_projects|open_session|create_project|remove_planner_item)/);
    assert.ok(joined.includes('mcp__claude-os__check_planner_item'), 'marking an item needs no prompt');
    const init = srv.log().filter((l) => l.kind === 'initialize').at(-1) as { request: { sdkMcpServers?: string[]; systemPrompt?: unknown } };
    assert.deepEqual(init.request.sdkMcpServers, ['claude-os']);
  });

  it('every session registers the note guard hook', async () => {
    const tab = await newTab();
    await send(tab.id, 'hello');
    await client.waitEvent(tab.id, 'result');
    const init = srv.log().filter((l) => l.kind === 'initialize').at(-1) as { request: { hooks?: { PreToolUse?: { matcher: string }[] } } };
    assert.equal(init.request.hooks?.PreToolUse?.[0]?.matcher, 'Read|Write|Edit|MultiEdit');
  });

  it('a work tab gets the two planner item tools and nothing else of the root server', async () => {
    const tab = await newTab();
    await send(tab.id, 'MCP LIST');
    const listed = await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('MCP_RESULT'));
    assert.deepEqual(JSON.parse((listed.blocks[0] as { text: string }).text.replace('MCP_RESULT ', '')).tools.sort(), ['check_planner_item', 'create_document_knowledge', 'kit_apply', 'kit_plan', 'list_document_knowledge', 'list_documents', 'list_kanban_cards', 'list_kanban_sprints', 'memory_search', 'move_kanban_card', 'patch_document', 'read_document', 'read_document_knowledge', 'remove_planner_item', 'report_progress', 'save_document', 'set_document_share', 'take_kanban_card', 'ui_action', 'update_kanban_card']);
    await client.waitEvent(tab.id, 'result');
  });

  it('a work tab has memory_search without a prompt', async () => {
    const notes = join(srv.dir, 'vault', 'projects', 'searchme');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'zebra-habitat.md'), '---\nname: zebra-habitat\ndescription: Where the zebra lives\ntype: project\n---\nThe zebra lives in the savanna.\n');
    // The store sees the note once the watcher fires; the HTTP search is the same index.
    await waitUntil(async () => (await srv.api<unknown[]>('GET', '/api/memory/search?q=zebra')).body.length > 0, 'the note indexed', 20_000);
    const tab = await newTab();
    await send(tab.id, `MCP memory_search ${JSON.stringify({ query: 'zebra savanna', project: '*' })}`);
    const listed = await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('MCP_RESULT'));
    const { tools, result } = JSON.parse((listed.blocks[0] as { text: string }).text.replace('MCP_RESULT ', ''));
    assert.ok(tools.includes('memory_search'));
    const text = result.content[0].text as string;
    assert.match(text, /^searchme\/zebra-habitat \[project\] — Where the zebra lives\n {2}.*\[savanna\]/);
    assert.ok(text.endsWith(`  ${join(notes, 'zebra-habitat.md')}`), text);
    assert.ok(spawns().at(-1)!.argv.join(' ').includes('mcp__claude-os__memory_search'), 'no prompt for a search');
    await client.waitEvent(tab.id, 'result');
  });

  it('asks permission with a diff, the turn waits, allow goes through', async () => {
    const tab = await newTab();
    const file = join(workDir, 'existing.txt');
    writeFileSync(file, 'one\ntwo\nthree\n');
    await send(tab.id, `TOOL Write ${JSON.stringify({ file_path: file, content: 'one\nTWO\nthree\n' })}`);
    const perm = await client.waitEvent(tab.id, 'permission');
    assert.equal(perm.tool, 'Write');
    assert.ok(perm.diff?.includes('-two') && perm.diff.includes('+TWO'), perm.diff ?? '');
    assert.equal(perm.title, 'Claude wants to use Write');
    const waiting = await tabOf(tab.id);
    assert.equal(waiting.status, 'waiting_permission');
    assert.equal(waiting.attention, true);
    assert.equal(client.events(tab.id).some((e) => e.e === 'result'), false);

    assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/respond/${perm.requestId}`, { kind: 'question', answers: {} })).status, 400);
    assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/respond/${perm.requestId}`, { kind: 'permission', allow: true })).status, 200);
    const resolved = await client.waitEvent(tab.id, 'resolved');
    assert.equal(resolved.decision, 'allow');
    const tr = await client.waitEvent(tab.id, 'tool_result');
    assert.equal(tr.isError, false);
    assert.equal(JSON.parse(tr.text).file_path, file);
    await client.waitEvent(tab.id, 'result');
    assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/respond/${perm.requestId}`, { kind: 'permission', allow: true })).status, 404);
  });

  it('deny returns the message to Claude', async () => {
    const tab = await newTab();
    await send(tab.id, `TOOL Edit ${JSON.stringify({ file_path: '/x', old_string: 'a', new_string: 'b' })}`);
    const perm = await client.waitEvent(tab.id, 'permission');
    assert.ok(perm.diff?.includes('-a') && perm.diff.includes('+b'));
    await srv.api('POST', `/api/tabs/${tab.id}/respond/${perm.requestId}`, { kind: 'permission', allow: false, message: 'нет' });
    const tr = await client.waitEvent(tab.id, 'tool_result');
    assert.equal(tr.isError, true);
    assert.equal(tr.text, 'нет');
    assert.equal((await client.waitEvent(tab.id, 'resolved')).decision, 'deny');
    await client.waitEvent(tab.id, 'result');
  });

  it('feeds AskUserQuestion answers back as updatedInput.answers', async () => {
    const tab = await newTab();
    const questions = [{ question: 'Какой?', header: 'Выбор', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];
    await send(tab.id, `TOOL AskUserQuestion ${JSON.stringify({ questions })}`);
    const q = await client.waitEvent(tab.id, 'question');
    assert.deepEqual(q.questions, questions);
    assert.equal((await tabOf(tab.id)).attention, true);
    await srv.api('POST', `/api/tabs/${tab.id}/respond/${q.requestId}`, { kind: 'question', answers: { 'Какой?': 'B' } });
    const tr = await client.waitEvent(tab.id, 'tool_result');
    const echoed = JSON.parse(tr.text);
    assert.deepEqual(echoed.answers, { 'Какой?': 'B' });
    assert.deepEqual(echoed.questions, questions);
    assert.equal((await client.waitEvent(tab.id, 'resolved')).decision, 'answered');
  });

  it('shows ExitPlanMode as a plan, approve and reject', async () => {
    const tab = await newTab();
    await send(tab.id, `TOOL ExitPlanMode ${JSON.stringify({ plan: '1. сделать' })}`);
    const plan = await client.waitEvent(tab.id, 'plan');
    assert.equal(plan.plan, '1. сделать');
    await srv.api('POST', `/api/tabs/${tab.id}/respond/${plan.requestId}`, { kind: 'plan', approve: false, message: 'иначе' });
    assert.equal((await client.waitEvent(tab.id, 'tool_result')).text, 'иначе');
    assert.equal((await client.waitEvent(tab.id, 'resolved')).decision, 'rejected');
    await client.waitEvent(tab.id, 'result');

    await send(tab.id, `TOOL ExitPlanMode ${JSON.stringify({ plan: '2. другое' })}`);
    const second = await client.waitEvent(tab.id, 'plan', (p) => p.plan.startsWith('2'));
    await srv.api('POST', `/api/tabs/${tab.id}/respond/${second.requestId}`, { kind: 'plan', approve: true });
    await client.waitEvent(tab.id, 'resolved', (r) => r.decision === 'approved');
  });

  it('interrupts a running turn', async () => {
    const tab = await newTab();
    await send(tab.id, 'SLOW');
    await client.waitEvent(tab.id, 'delta');
    assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/interrupt`)).status, 200);
    const result = await client.waitEvent(tab.id, 'result');
    assert.equal(result.interrupted, true);
    assert.equal(result.error, null);
    await waitUntil(async () => (await tabOf(tab.id)).status === 'idle', 'idle after interrupt');
    // The process lives on and takes the next message.
    const before = spawns().length;
    await send(tab.id, 'after interrupt');
    await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('after interrupt'));
    assert.equal(spawns().length, before);
  });

  it('interrupt while waiting for permission settles the card', async () => {
    const tab = await newTab();
    await send(tab.id, `TOOL Write ${JSON.stringify({ file_path: '/x', content: 'y' })}`);
    await client.waitEvent(tab.id, 'permission');
    await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
    assert.equal((await client.waitEvent(tab.id, 'resolved')).decision, 'interrupted');
    assert.equal((await client.waitEvent(tab.id, 'result')).interrupted, true);
    assert.equal((await tabOf(tab.id)).attention, false);
  });

  it('queues messages during a turn and runs them in order', async () => {
    const tab = await newTab();
    await send(tab.id, 'HOLD 300');
    await client.waitEvent(tab.id, 'status', (s) => s.status === 'working');
    await send(tab.id, 'first queued');
    await send(tab.id, 'second queued');
    const queued = client.events(tab.id).filter((e) => e.e === 'user' && e.queued === true);
    assert.equal(queued.length, 2);
    assert.equal((await tabOf(tab.id)).queued, 2);
    assert.equal(srv.log().filter((l) => l.kind === 'user' && l.content === 'first queued').length, 0, 'held by the server');

    await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('second queued'));
    const dequeued = client.events(tab.id).filter((e) => e.e === 'user' && e.queued === false);
    assert.equal(dequeued.length, 2);
    await waitUntil(async () => (await tabOf(tab.id)).queued === 0 && (await tabOf(tab.id)).status === 'idle', 'queue drained');
    assert.equal(client.events(tab.id).filter((e) => e.e === 'result').length, 3);
  });

  it('interrupt drops the queue with a warning instead of spending tokens', async () => {
    const tab = await newTab();
    await send(tab.id, 'SLOW');
    await client.waitEvent(tab.id, 'delta');
    await send(tab.id, 'never run');
    await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
    const warning = await client.waitEvent(tab.id, 'warning');
    assert.ok(warning.text.includes('never run'));
    await client.waitEvent(tab.id, 'result');
    assert.equal(srv.log().filter((l) => l.kind === 'user' && l.content === 'never run').length, 0);
    assert.equal((await tabOf(tab.id)).queued, 0);
  });

  it('a socket drop keeps the turn; reconnect replays after lastSeq, without duplicates', async () => {
    const tab = await newTab();
    const second = await srv.connect();
    second.subscribe(tab.id);
    await send(tab.id, 'HOLD 250');
    await second.waitEvent(tab.id, 'status', (s) => s.status === 'working');
    const seen = second.events(tab.id);
    const lastSeq = seen.at(-1)!.seq;
    await second.close();

    await client.waitEvent(tab.id, 'result'); // finished with that socket gone
    const third = await srv.connect();
    third.subscribe(tab.id, lastSeq);
    const replayed = await third.waitEvent(tab.id, 'result');
    assert.ok(replayed);
    const events = third.events(tab.id);
    assert.ok(events.every((e) => e.seq > lastSeq));
    assert.equal(new Set(events.map((e) => e.seq)).size, events.length);
    // Live events follow the replay.
    await send(tab.id, 'live after replay');
    await third.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('live after replay'));
    await third.close();
  });

  it('history merges the transcript and the live buffer without duplicates', async () => {
    const tab = await newTab();
    await send(tab.id, 'hist one');
    await client.waitEvent(tab.id, 'result');
    const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${tab.id}/history`)).body;
    const users = history.filter((e) => e.e === 'user');
    assert.equal(users.length, 1);
    assert.equal(history.filter((e) => e.e === 'assistant').length, 1);
    assert.equal(history.filter((e) => e.e === 'delta').length, 0, 'deltas replaced by assistant');
    const seqs = history.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  it('warns when a neighbour tab in the same cwd is mid-turn', async () => {
    const dir = join(srv.dir, 'shared-cwd');
    mkdirSync(dir);
    const a = await newTab({}, dir);
    const b = await newTab({}, dir);
    await send(a.id, 'HOLD 400');
    await client.waitEvent(a.id, 'status', (s) => s.status === 'working');
    await send(b.id, 'starts beside it');
    const w = await client.waitEvent(b.id, 'warning');
    assert.ok(w.text.includes(a.title));
    await client.waitEvent(b.id, 'result');
    assert.equal(client.events(a.id).some((e) => e.e === 'warning'), false);
    await client.waitEvent(a.id, 'result');
  });

  it('adds images as blocks, saves other files under data, keeps /compact a plain prompt', async () => {
    const tab = await newTab();
    await send(tab.id, 'see these', [
      { name: 'p.png', mediaType: 'image/png', base64: 'aGk=' },
      { name: '../../evil name.txt', mediaType: 'text/plain', base64: Buffer.from('файл').toString('base64') },
    ]);
    await client.waitEvent(tab.id, 'result');
    const sent = srv.log().filter((l) => l.kind === 'user').at(-1) as { content: { type: string; text?: string; source?: { data: string } }[] };
    assert.equal(sent.content[0].type, 'image');
    assert.equal(sent.content[0].source?.data, 'aGk=');
    const note = sent.content[1].text!;
    const path = note.match(/Attached file: (.+)/)![1];
    assert.ok(path.startsWith(join(srv.dataDir, 'uploads', tab.id)), path);
    assert.equal(readFileSync(path, 'utf8'), 'файл');

    await send(tab.id, '/compact');
    await client.waitEvent(tab.id, 'warning', (w) => w.key === 'compacted');
    const last = srv.log().filter((l) => l.kind === 'user').at(-1) as { content: unknown };
    assert.equal(last.content, '/compact');
    await srv.api('DELETE', `/api/tabs/${tab.id}`);
    assert.equal(existsSync(path), false);
  });

  it('forwards slash commands with needsTerminal, from the CLI and the list', async () => {
    const tab = await newTab();
    await send(tab.id, 'slash');
    const init = await client.waitEvent(tab.id, 'init');
    const byName = Object.fromEntries(init.slashCommands.map((c) => [c.name, c.needsTerminal]));
    assert.deepEqual(byName, { compact: false, cost: false, config: true, 'my-skill': false, 'odd-terminal': true });
  });

  it('completes @-mentions via git and via a walk', async () => {
    const plain = join(srv.dir, 'plain');
    mkdirSync(join(plain, 'src'), { recursive: true });
    mkdirSync(join(plain, 'node_modules'));
    writeFileSync(join(plain, 'src', 'Alpha.ts'), '');
    writeFileSync(join(plain, 'node_modules', 'alpha-dep.js'), '');
    const tab = await newTab({}, plain);
    assert.deepEqual((await srv.api(`GET`, `/api/tabs/${tab.id}/files?q=alpha`)).body, ['src/Alpha.ts']);

    const repo = join(srv.dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'ignored.txt'), '');
    writeFileSync(join(repo, 'kept.txt'), '');
    const repoTab = await newTab({}, repo);
    assert.deepEqual((await srv.api(`GET`, `/api/tabs/${repoTab.id}/files?q=.txt`)).body, ['kept.txt']);
  });

  it('passes --worktree only on the first start; later resumes run inside it', async () => {
    const repo = join(srv.dir, 'wt-repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const refused = await srv.api('POST', '/api/tabs', { cwd: workDir, worktree: true });
    assert.equal(refused.status, 400, 'not a repo');
    const tab = await newTab({ worktree: true }, repo);
    assert.equal(tab.worktree, true);
    await send(tab.id, 'in worktree');
    await client.waitEvent(tab.id, 'result');
    const { argv } = spawns().at(-1)!;
    assert.ok(argv.join(' ').includes(`--worktree`), argv.join(' '));
    const after = await tabOf(tab.id);
    assert.ok(after.cwd.startsWith(join(repo, '.claude', 'worktrees')), after.cwd);
    // Second process of the same tab: resumes in place, no second worktree.
    mkdirSync(after.cwd, { recursive: true });
    await srv.api('DELETE', `/api/tabs/${tab.id}`);
    const resumed = await newTab({ resumeSessionId: after.sessionId, cwd: after.cwd });
    await send(resumed.id, 'again');
    await client.waitEvent(resumed.id, 'result');
    assert.doesNotMatch(spawns().at(-1)!.argv.join(' '), /--worktree/);
    assert.equal(spawns().at(-1)!.cwd, after.cwd);
  });

  it('gives a connected project its vault dir and the _state note on a new session only', async () => {
    const dir = join(srv.dir, 'connected');
    const vaultDir = join(srv.dir, 'vault', 'projects', 'connected');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: vaultDir }));
    const tab = await newTab({}, dir);
    assert.ok(tab.project);
    mkdirSync(join(srv.dir, 'vault', '_state'), { recursive: true });
    writeFileSync(join(srv.dir, 'vault', '_state', `${tab.project}.md`), 'ЗАМЕТКА-СОСТОЯНИЯ');
    await waitUntil(async () => (await srv.api<{ key: string; memoryConnected: boolean }[]>('GET', '/api/projects')).body
      .some((p) => p.key === tab.project && p.memoryConnected), 'memory sees the connection', 30_000);
    await send(tab.id, 'first');
    await client.waitEvent(tab.id, 'result');
    const argv = spawns().at(-1)!.argv.join(' ');
    assert.ok(argv.includes(`"autoMemoryDirectory":"${vaultDir}"`), argv);
    const init = () => JSON.stringify(srv.log().filter((l) => l.kind === 'initialize').at(-1));
    assert.ok(init().includes('ЗАМЕТКА-СОСТОЯНИЯ'), init());

    // A resumed process gets the vault dir again, the note is not repeated.
    const { sessionId } = await tabOf(tab.id);
    await srv.api('DELETE', `/api/tabs/${tab.id}`);
    const resumed = await newTab({ resumeSessionId: sessionId, cwd: dir });
    await send(resumed.id, 'second');
    await client.waitEvent(resumed.id, 'result');
    assert.ok(spawns().at(-1)!.argv.join(' ').includes('autoMemoryDirectory'));
    assert.ok(!init().includes('ЗАМЕТКА-СОСТОЯНИЯ'), init());
  });

  it('any Claude OS session writes notes to the vault: old notes copied first, project settings untouched, rules appended', async () => {
    const dir = join(srv.dir, 'never-connected');
    mkdirSync(dir, { recursive: true });
    const tab = await newTab({}, dir);
    const old = join(srv.configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'old_note.md'), 'старая заметка');
    await send(tab.id, 'first');
    await client.waitEvent(tab.id, 'result');
    const vaultDir = join(srv.dir, 'vault', 'projects', tab.project!);
    assert.ok(spawns().at(-1)!.argv.join(' ').includes(`"autoMemoryDirectory":"${vaultDir}"`));
    assert.equal(readFileSync(join(vaultDir, 'old_note.md'), 'utf8'), 'старая заметка');
    assert.ok(existsSync(join(old, 'old_note.md')), 'the source stays');
    assert.ok(!existsSync(join(dir, '.claude')), 'project settings untouched');
    const init = JSON.stringify(srv.log().filter((l) => l.kind === 'initialize').at(-1));
    assert.ok(init.includes('One fact per note'), init);
    assert.ok(init.includes('Write file paths in full (absolute)'), 'the path rule is appended');
  });

  it('the profile block comes first in the appended prompt', async () => {
    const saved = await srv.api('PUT', '/api/settings/profile', { name: 'Ann', language: 'de', projectsDir: srv.dir, questionLevel: 'minimal' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const tab = await newTab();
    await send(tab.id, 'who am I');
    await client.waitEvent(tab.id, 'result');
    const init = JSON.stringify(srv.log().filter((l) => l.kind === 'initialize').at(-1));
    const at = init.indexOf("The user's name is Ann.");
    assert.ok(at >= 0, init);
    assert.ok(at < init.indexOf('One fact per note'), 'before the other rules');
  });

  it('question level caps AskUserQuestion per user message', async () => {
    const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];
    const ask = (n: number) => `TOOLS ${n} AskUserQuestion ${JSON.stringify({ questions })}`;
    const asked = (id: string) => client.events(id).filter((e) => e.e === 'question');
    // Answers every question card as it comes, until the turn's result.
    const run = async (id: string, text: string) => {
      const before = client.events(id).filter((e) => e.e === 'result').length;
      await send(id, text);
      const answered = new Set<string>();
      await waitUntil(async () => {
        for (const q of asked(id)) {
          if (q.e !== 'question' || answered.has(q.requestId)) continue;
          answered.add(q.requestId);
          await srv.api('POST', `/api/tabs/${id}/respond/${q.requestId}`, { kind: 'question', answers: { 'Which?': 'A' } });
        }
        return client.events(id).filter((e) => e.e === 'result').length > before;
      }, 'turn result');
      return client.events(id).filter((e) => e.e === 'tool_result');
    };
    const profile = (questionLevel: string) => srv.api('PUT', '/api/settings/profile', { name: 'Ann', language: 'de', projectsDir: srv.dir, questionLevel });

    assert.equal((await profile('balanced')).status, 200);
    const balanced = await newTab();
    const third = await run(balanced.id, ask(3));
    assert.equal(asked(balanced.id).length, 2);
    assert.deepEqual(third.map((r) => r.e === 'tool_result' && r.isError), [false, false, true]);

    assert.equal((await profile('minimal')).status, 200);
    const tab = await newTab();
    const results = await run(tab.id, ask(2));
    assert.equal(asked(tab.id).length, 1, 'no second question card');
    const denied = results[1];
    assert.ok(denied.e === 'tool_result' && denied.isError);
    assert.equal(denied.e === 'tool_result' && denied.text, 'Question level minimal: decide, state the assumption, continue.');
    await run(tab.id, ask(1));
    assert.equal(asked(tab.id).length, 2, 'a new user message allows a question again');
  });

  it('marks the session as started by the OS and forwards rate limits to the bus', async () => {
    const tab = await newTab();
    await send(tab.id, 'RATE');
    await client.waitEvent(tab.id, 'result');
    const { sessionId } = await tabOf(tab.id);
    await waitUntil(async () => {
      const { body } = await srv.api<{ id: string; origin: string }[]>('GET', '/api/sessions');
      return body.some((s) => s.id === sessionId && s.origin === 'os');
    }, 'origin=os');
    const { body } = await srv.api<{ rateLimits: { sessionId: string }[] }>('GET', '/api/analytics');
    assert.ok(body.rateLimits.some((r) => r.sessionId === sessionId), JSON.stringify(body.rateLimits));
  });

  it('a tab Claude OS opens for itself counts its tokens under that source', async () => {
    const tab = await newTab({ source: 'widget', sourceDetail: 'w1' });
    await send(tab.id, 'widget job');
    await client.waitEvent(tab.id, 'result');
    const today = new Date().toLocaleDateString('sv');
    await waitUntil(async () => {
      const { body } = await srv.api<Analytics>('GET', `/api/analytics?from=${today}&to=${today}`);
      return body.bySource.some((s) => s.name === 'widget' && s.input > 0);
    }, 'widget tokens');
  });

  it('the root tab is Claude OS own load; another tab in the root folder (a document tab works there) is the user\'s', async () => {
    const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
    client.subscribe(root.id);
    await send(root.id, 'root job');
    await client.waitEvent(root.id, 'result');
    const mine = await newTab({}, root.cwd);
    await send(mine.id, 'my job');
    await client.waitEvent(mine.id, 'result');
    const db = new DatabaseSync(join(srv.dataDir, 'claude-os.db'), { readOnly: true });
    try {
      const sourceOf = async (id: string) => db.prepare('SELECT os_source s FROM sessions WHERE id = ?').get((await tabOf(id)).sessionId)?.s;
      assert.equal(await sourceOf(root.id), 'root');
      assert.equal(await sourceOf(mine.id), '', 'the user\'s work, not counted whatever its folder');
    } finally {
      db.close();
    }
    await srv.api('POST', `/api/tabs/${root.id}/reset`); // later tests expect the root tab to start a fresh process
  });

  it('an unknown source from the page is ignored', async () => {
    const tab = await newTab({ source: 'bogus', sourceDetail: 'x' });
    const db = new DatabaseSync(join(srv.dataDir, 'claude-os.db'), { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare('SELECT source, source_detail d FROM tabs WHERE id = ?').get(tab.id) }, { source: null, d: null });
    } finally {
      db.close();
    }
  });

  it('/branch keeps the source of the tab it copies', async () => {
    const tab = await newTab({ source: 'crash-fix' });
    await send(tab.id, 'to branch');
    await client.waitEvent(tab.id, 'result');
    const branched = await srv.api<Tab>('POST', `/api/tabs/${tab.id}/branch`, {});
    assert.equal(branched.status, 200, JSON.stringify(branched.body));
    const db = new DatabaseSync(join(srv.dataDir, 'claude-os.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT source FROM tabs WHERE id = ?').get(branched.body.id)?.source, 'crash-fix');
      assert.ok(branched.body.sessionId);
      assert.equal(db.prepare('SELECT os_source s FROM sessions WHERE id = ?').get(branched.body.sessionId)?.s, 'crash-fix', 'the copy counts too');
    } finally {
      db.close();
    }
  });

  it('PATCH reaches the running process', async () => {
    const tab = await newTab();
    await send(tab.id, 'patch me');
    await client.waitEvent(tab.id, 'result');
    const patched = await srv.api<Tab>('PATCH', `/api/tabs/${tab.id}`, { model: 'fake-opus', effort: 'high', title: 'Новое' });
    assert.equal(patched.body.model, 'fake-opus');
    assert.equal(patched.body.effort, 'high');
    assert.equal(patched.body.title, 'Новое');
    const controls = srv.log().filter((l) => l.kind === 'control') as { subtype: string; request: Record<string, unknown> }[];
    assert.ok(controls.some((c) => c.subtype === 'set_model' && c.request.model === 'fake-opus'), JSON.stringify(controls.map((c) => c.subtype)));
    assert.ok(controls.some((c) => c.subtype === 'apply_flag_settings'), JSON.stringify(controls.map((c) => c.subtype)));
    assert.equal((await srv.api('PATCH', `/api/tabs/${tab.id}`, { effort: 'ludicrous' })).status, 400);
    assert.equal((await srv.api('PATCH', `/api/tabs/${tab.id}`, { model: '--dangerous' })).status, 400);
  });

  it('reports a crash with stderr, then the next message resumes', async () => {
    const tab = await newTab();
    await send(tab.id, 'first');
    await client.waitEvent(tab.id, 'result');
    const { sessionId } = await tabOf(tab.id);
    await send(tab.id, 'CRASH');
    const err = await client.waitEvent(tab.id, 'error');
    assert.ok(err.text.includes('fake crash on stderr'), err.text);
    await waitUntil(async () => (await tabOf(tab.id)).status === 'idle', 'idle after crash');
    await send(tab.id, 'back again');
    await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('back again'));
    assert.ok(spawns().at(-1)!.argv.join(' ').includes(`--resume ${sessionId}`) || spawns().at(-1)!.argv.join(' ').includes(`--resume=${sessionId}`));
  });

  it('lists models from the CLI, not from a guess', async () => {
    const res = await srv.api('GET', '/api/models');
    assert.deepEqual(res.body, [{ id: 'fake-sonnet', label: 'Fake Sonnet' }, { id: 'fake-opus', label: 'Fake Opus' }]);
    const users = srv.log().filter((l) => l.kind === 'user').length;
    await srv.api('GET', '/api/models');
    assert.equal(srv.log().filter((l) => l.kind === 'user').length, users, 'no prompt is sent');
  });

  it('wires the whole MCP server into the root tab; create_project refuses traversal', async () => {
    const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
    client.subscribe(root.id);
    await send(root.id, 'MCP LIST');
    const listed = await client.waitEvent(root.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('MCP_RESULT'));
    const payload = (a: typeof listed) => JSON.parse((a.blocks[0] as { text: string }).text.replace('MCP_RESULT ', ''));
    assert.deepEqual(payload(listed).tools.sort(), ['add_kanban_card', 'add_kanban_sprint', 'check_planner_item', 'create_document_knowledge', 'create_project', 'file_planner_note', 'list_document_knowledge', 'list_documents', 'list_kanban_cards', 'list_kanban_sprints', 'list_projects', 'list_sessions', 'memory_search', 'move_kanban_card', 'open_session', 'open_sessions', 'patch_document', 'read_document', 'read_document_knowledge', 'remove_kanban_sprint', 'remove_planner_item', 'report_progress', 'restart_claude_os', 'resume_session', 'save_document', 'service_task', 'session_status', 'set_document_share', 'set_project_map', 'take_kanban_card', 'ui_action', 'update_kanban_card', 'update_kanban_sprint', 'update_project']);
    const init = srv.log().filter((l) => l.kind === 'initialize').at(-1) as { request: { sdkMcpServers: string[] } };
    assert.deepEqual(init.request.sdkMcpServers, ['claude-os']);
    assert.ok(spawns().at(-1)!.argv.join(' ').includes('mcp__claude-os__list_projects'), 'read tools pre-approved');
    assert.ok(spawns().at(-1)!.argv.join(' ').includes('mcp__claude-os__open_sessions'), 'handing work out is its job');
    assert.ok(!spawns().at(-1)!.argv.join(' ').includes('mcp__claude-os__remove_kanban_sprint'), 'removing a sprint asks');
    await client.waitEvent(root.id, 'result');

    for (const name of ['../evil', '..', 'a/b', '/etc/x', '.hidden', 'a..b', '']) {
      const before = client.events(root.id).length;
      await send(root.id, `MCP create_project ${JSON.stringify({ name, prompt: 'x' })}`);
      await waitUntil(() => client.events(root.id).slice(before).some((e) => e.e === 'result'), 'refusal');
      const text = JSON.stringify(client.events(root.id).slice(before));
      assert.ok(text.includes('isError'), `${name}: ${text}`);
    }
    assert.equal(existsSync(join(srv.dir, 'evil')), false);
    assert.equal(existsSync(srv.newProjects) ? readdirCount(srv.newProjects) : 0, 0);
  });

  it('create_project makes the dir, opens a tab and starts the session', async () => {
    const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
    client.subscribe(root.id);
    const mark = client.messages.length;
    await send(root.id, `MCP create_project ${JSON.stringify({ name: 'fresh-one', prompt: 'build it' })}`);
    await waitUntil(() => client.messages.slice(mark).some((m) => m.t === 'tab_opened'), 'tab_opened');
    const opened = client.messages.slice(mark).find((m) => m.t === 'tab_opened')!;
    assert.ok(opened.t === 'tab_opened' && opened.focus);
    const tab = opened.t === 'tab_opened' ? opened.tab : null;
    assert.equal(tab!.cwd, join(srv.newProjects, 'fresh-one'));
    assert.ok(statSync(tab!.cwd).isDirectory());
    client.subscribe(tab!.id);
    await client.waitEvent(tab!.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('build it'));
  });

  it('read-only tabs refuse to send; a live session cannot be taken over; an ended one can', async () => {
    const liveId = '11111111-1111-4111-8111-111111111111';
    const endedId = '22222222-2222-4222-8222-222222222222';
    const sessionsDir = join(srv.configDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: liveId, cwd: workDir, status: 'idle', kind: 'interactive', updatedAt: Date.now() }));
    const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-');
    const journalDir = join(srv.configDir, 'projects', encoded);
    mkdirSync(journalDir, { recursive: true });
    for (const id of [liveId, endedId]) {
      writeFileSync(join(journalDir, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u-' + id, sessionId: id, cwd: workDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'старое ' + id } }) + '\n');
    }

    const known = async (id: string, status?: string) => {
      const { body } = await srv.api<{ id: string; status: string }[]>('GET', '/api/sessions');
      return body.some((s) => s.id === id && (!status || s.status === status));
    };
    await waitUntil(() => known(endedId), 'journal sees the session', 15_000);
    await waitUntil(async () => !(await known(liveId, 'ended')) && (await known(liveId)), 'journal sees it live', 15_000);

    const readonly = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: liveId, readonly: true });
    assert.equal(readonly.status, 200, JSON.stringify(readonly.body));
    assert.equal(readonly.body.kind, 'readonly');
    const refused = await send(readonly.body.id, 'hi') as { status: number; body: { error: string; key: string } };
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Read-only tab/);
    assert.equal(refused.body.key, 'readonlySend');
    const transcript = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${readonly.body.id}/history`)).body;
    assert.ok(JSON.stringify(transcript).includes('старое ' + liveId));

    const live = await srv.api<{ error: string }>('POST', '/api/tabs', { resumeSessionId: liveId });
    assert.equal(live.status, 409);
    assert.match(live.body.error, /still alive/);

    const ended = await newTab({ resumeSessionId: endedId, cwd: undefined });
    assert.equal(ended.kind, 'work');
    assert.equal(ended.sessionId, endedId);
    assert.equal(ended.cwd, workDir);
    await send(ended.id, 'continue here');
    await client.waitEvent(ended.id, 'result');
    assert.match(spawns().at(-1)!.argv.join(' '), new RegExp(`--resume[ =]${endedId}`));
    const again = await srv.api('POST', '/api/tabs', { resumeSessionId: endedId });
    assert.equal(again.status, 409, 'already open in a tab');

    // The root goes on with an old session through its MCP: the tab that holds it, or a refusal for an unknown id.
    const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
    client.subscribe(root.id);
    for (const [id, expect] of [[endedId, `"tabId": "${ended.id}"`], ['33333333-3333-4333-8333-333333333333', 'isError']] as const) {
      const last = Math.max(0, ...(await srv.api<ChatEvent[]>('GET', `/api/tabs/${root.id}/history`)).body.map((e) => e.seq));
      const fresh = () => client.events(root.id).filter((e) => e.seq > last);
      await send(root.id, `MCP resume_session ${JSON.stringify({ session_id: id })}`);
      await waitUntil(() => fresh().some((e) => e.e === 'result'), 'resume answer');
      const text = JSON.stringify(fresh().filter((e) => e.e === 'assistant')).replace(/\\/g, '');
      assert.ok(text.includes(expect), `${id}: ${text}`);
    }
  });
});

describe('restart and idle stop', () => {
  it('restores tabs, shows the cut-off turn as interrupted, resumes on the next message', async () => {
    const srv = await startServer();
    try {
      const workDir = mkdtempSync(join(srv.dir, 'w-'));
      let client = await srv.connect();
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir, title: 'Выживет', model: 'fake-opus' })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'SLOW' });
      await client.waitEvent(tab.id, 'delta');
      const before = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
      assert.ok(before.sessionId);
      await client.close();

      await srv.restart();
      const restored = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
      assert.equal(restored.title, 'Выживет');
      assert.equal(restored.model, 'fake-opus');
      assert.equal(restored.sessionId, before.sessionId);
      assert.equal(restored.status, 'idle');
      assert.equal((await srv.api<Tab[]>('GET', '/api/tabs')).body.filter((t) => t.kind === 'root').length, 1);

      client = await srv.connect();
      client.subscribe(tab.id, 999_999_999_999_999);
      assert.equal(client.events(tab.id).length, 0);
      client.subscribe(tab.id, 0);
      await client.waitEvent(tab.id, 'interrupted');
      const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${tab.id}/history`)).body;
      assert.ok(history.some((e) => e.e === 'user'));
      assert.equal(history.at(-1)!.e, 'interrupted');

      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'after restart' });
      await client.waitEvent(tab.id, 'result');
      const spawn = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { argv: string[] };
      assert.match(spawn.argv.join(' '), new RegExp(`--resume[ =]${before.sessionId}`));
      await client.close();
    } finally {
      await srv.destroy();
    }
  });

  it('stops the process after the idle window, the next message resumes', async () => {
    const srv = await startServer({ CLAUDE_OS_TAB_IDLE_MS: '200' });
    try {
      const workDir = mkdtempSync(join(srv.dir, 'w-'));
      const client = await srv.connect();
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'one' });
      await client.waitEvent(tab.id, 'result');
      const spawn = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { pid: number };
      await waitUntil(() => !alive(spawn.pid), 'process stopped');
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'two' });
      await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('two'));
      const spawns = srv.log().filter((l) => l.kind === 'spawn');
      assert.equal(spawns.length, 2);
      assert.match((spawns[1] as { argv: string[] }).argv.join(' '), /--resume/);
      await client.close();
    } finally {
      await srv.destroy();
    }
  });
});

describe('reopening a closed tab', () => {
  it('reopen right after close waits for own child', async () => {
    // The real CLI keeps its registry entry and lives on for seconds after the SDK closes it.
    const srv = await startServer({ FAKE_CLAUDE_REGISTRY: '1', FAKE_CLAUDE_LINGER_MS: '4000' });
    try {
      const workDir = mkdtempSync(join(srv.dir, 'w-'));
      const client = await srv.connect();
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'one' });
      await client.waitEvent(tab.id, 'result');
      const { sessionId } = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
      const old = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { pid: number };

      assert.equal((await srv.api('DELETE', `/api/tabs/${tab.id}`)).status, 200);
      assert.ok(alive(old.pid), 'the closed tab\'s process is still on its way out');
      const reopened = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: sessionId, cwd: workDir });
      assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
      assert.equal(alive(old.pid), false, 'the old process ended before a new one could start');
      client.subscribe(reopened.body.id);
      assert.equal((await srv.api('POST', `/api/tabs/${reopened.body.id}/send`, { text: 'two' })).status, 200);
      await client.waitEvent(reopened.body.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('two'));
      assert.match((srv.log().filter((l) => l.kind === 'spawn').at(-1) as { argv: string[] }).argv.join(' '), new RegExp(`--resume[ =]${sessionId}`));
      await client.close();
    } finally {
      await srv.destroy();
    }
  });
});

describe('a terminal holding the session of a closed tab', () => {
  it('its process is never taken for the tab\'s own, never killed, and still guards the session', async () => {
    const srv = await startServer({ FAKE_CLAUDE_REGISTRY: '1', FAKE_CLAUDE_LINGER_MS: '4000' });
    const terminal = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const workDir = mkdtempSync(join(srv.dir, 'w-'));
      const client = await srv.connect();
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'one' });
      await client.waitEvent(tab.id, 'result');
      const { sessionId } = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
      // The newest entry of the session is the terminal's: a pid taken from the registry alone would be that one.
      const stat = readFileSync(`/proc/${terminal.pid}/stat`, 'latin1');
      writeFileSync(join(srv.configDir, 'sessions', `${terminal.pid}.json`), JSON.stringify({ pid: terminal.pid, procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], sessionId, cwd: workDir, status: 'idle', kind: 'interactive', updatedAt: Date.now() + 60_000 }));

      assert.equal((await srv.api('DELETE', `/api/tabs/${tab.id}`)).status, 200);
      const reopened = await srv.api<{ key: string }>('POST', '/api/tabs', { resumeSessionId: sessionId, cwd: workDir });
      assert.equal(reopened.status, 409, JSON.stringify(reopened.body));
      assert.equal(reopened.body.key, 'sessionAlive');
      assert.ok(alive(terminal.pid!), 'the terminal is not ours to end');
      await client.close();
    } finally {
      terminal.kill('SIGKILL');
      await srv.destroy();
    }
  });
});

describe('a closed tab\'s process still alive', () => {
  it('create without a settle refuses: a second writer never starts; after the settle it opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-os-closed-child-'));
    const claudeDir = join(dir, 'claude');
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const old = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const ctx = {
        db: new DatabaseSync(':memory:'),
        paths: { root: join(dir, 'root'), repo: dir, data: dir, config: dir, vault: dir, service: join(dir, 'service'), setup: join(dir, 'setup'), claudeDir },
        bus: new EventEmitter(),
        app: { log: { warn() {} } },
        journal: { listProjects: () => [], listSessions: () => [], projectForCwd: () => null, dismissLost() {} },
        invalidate() {},
        broadcast() {},
      };
      const chat = new Chat(ctx as never);
      const sessionId = '44444444-4444-4444-8444-444444444444';
      const procStart = procStartOf(old.pid!)!;
      writeFileSync(join(claudeDir, 'sessions', `${old.pid}.json`), JSON.stringify({ pid: old.pid, procStart, sessionId, cwd: dir, status: 'idle' }));
      // As close() leaves it: the tab's process, remembered on its way out.
      (chat as unknown as { closedChildren: Map<string, unknown> }).closedChildren.set(sessionId, { pid: old.pid, procStart });

      assert.throws(() => chat.create({ resumeSessionId: sessionId, cwd: dir }), (err: { key?: string }) => err.key === 'sessionAlive');
      assert.ok(alive(old.pid!));
      await chat.settleClosedChild(sessionId);
      assert.equal(procStartOf(old.pid!), null, 'ended before anything new starts');
      assert.equal(chat.create({ resumeSessionId: sessionId, cwd: dir }).sessionId, sessionId);
    } finally {
      old.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resume_session of the root right after a close ends the old process first', async () => {
    const srv = await startServer({ FAKE_CLAUDE_REGISTRY: '1', FAKE_CLAUDE_LINGER_MS: '4000' });
    try {
      const workDir = mkdtempSync(join(srv.dir, 'w-'));
      const client = await srv.connect();
      const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir })).body;
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'one' });
      await client.waitEvent(tab.id, 'result');
      const { sessionId } = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!;
      const old = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { pid: number };

      const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
      client.subscribe(root.id);
      assert.equal((await srv.api('DELETE', `/api/tabs/${tab.id}`)).status, 200);
      assert.ok(alive(old.pid));
      await srv.api('POST', `/api/tabs/${root.id}/send`, { text: `MCP resume_session ${JSON.stringify({ session_id: sessionId, prompt: 'дальше' })}` });
      await client.waitEvent(root.id, 'result');
      assert.equal(alive(old.pid), false, 'the old process ended before the tab was made'); // alone it lingers for seconds
      const answer = JSON.stringify(client.events(root.id).filter((e) => e.e === 'assistant')).replace(/\\/g, '');
      assert.ok(!answer.includes('isError'), answer);
      const reopened = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.sessionId === sessionId)!;
      assert.ok(reopened, 'the session is in a tab again');
      await waitUntil(() => srv.log().filter((l) => l.kind === 'user' && l.content === 'дальше').length === 1, 'the prompt went to a new process');
      const fresh = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { pid: number };
      assert.notEqual(fresh.pid, old.pid);
      await client.close();
    } finally {
      await srv.destroy();
    }
  });
});

describe('units', () => {
  it('projectDirFor keeps names inside the base', () => {
    assert.equal(projectDirFor('/base', 'ok-name_1.2'), '/base/ok-name_1.2');
    for (const bad of ['..', '../x', 'a/b', '/abs', '.hidden', '-flag', 'a..b', '', 'a\\b', 'x'.repeat(65), 'имя']) {
      assert.equal(projectDirFor('/base', bad), null, bad);
    }
  });

  it('unifiedDiff shows the changed range with context', () => {
    const diff = unifiedDiff('/f', 'a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nX\nf\ng\nh');
    assert.equal(diff, ['--- /f', '+++ /f', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+X', ' f', ' g', ' h'].join('\n'));
    assert.ok(unifiedDiff('/n', '', 'new\nfile').includes('+new\n+file'));
  });

  it('a cut diff ends with the line the UI shows in its own language', () => {
    const last = unifiedDiff('/big', '', Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n')).split('\n').at(-1)!;
    assert.equal(truncatedLines(last), 50);
    assert.equal(truncatedLines(' ... truncated, 5 more lines'), null, 'a context line is not the marker');
  });

  it('slashCommands merges the CLI list with ours', () => {
    assert.deepEqual(slashCommands(['compact', 'config', 'x'], ['x']), [
      { name: 'compact', needsTerminal: false },
      { name: 'config', needsTerminal: true },
      { name: 'x', needsTerminal: true },
    ]);
  });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readdirCount(dir: string): number {
  return execFileSync('ls', ['-A', dir]).toString().split('\n').filter(Boolean).length;
}
