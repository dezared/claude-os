import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { MemoryGraph, MemoryMigrationPlan, VaultCopyPreview, WikiRunView } from '../../shared/contract.ts';
import type { ChatApi } from '../context.ts';
import { registerMemory } from './index.ts';
import { encodeDir } from './store.ts';
import { makeKit, type TestKit } from './testkit.ts';
import { safely, sha256 } from './util.ts';
import { isWikiManaged } from './wikiManaged.ts';
import { migratedSources, splitBatches } from './wikiMigration.ts';

let kit: TestKit;
let opened: { req: { project?: string; cwd?: string; title?: string }; prompt: string; opts: unknown; tabId: string }[];
let sent: { tabId: string; text: string }[];
beforeEach(() => {
  kit = makeKit();
  opened = [];
  sent = [];
});
afterEach(() => kit.close());

const read = (path: string) => safely(() => readFileSync(path, 'utf8'), null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const projDir = (key: string) => join(kit.paths.vault, 'projects', key);
const note = (key: string, file: string) => join(projDir(key), file);
const rootOf = (key: string) => join(kit.base, `${key}-root`);
const wiki = (name: string, description: string, body: string, tags = 'db') =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n  tags: [${tags}]\n---\n${body}\n`;

const OLD_PROJECT = '---\nname: Project\ndescription: everything about p\ntype: project\n---\nMigrations run via `doctrine:migrations:diff`. The zebra rule.\n';
const OLD_B = '---\nname: b\ndescription: b note\n---\nCache TTL is 300 seconds.\n';
const OLD_MEMORY = '- [Project](project.md) — everything\n';
const Q_LINKS = wiki('q-links', 'Where q points', 'See [[project]] for the db rules.', 'infra');
const DB = wiki('db-migrations', 'How migrations are made', 'Run `doctrine:migrations:diff`; see [[cache-ttl]].');
const CACHE = wiki('cache-ttl', 'How long the cache keeps entries', 'Cache TTL is 300 seconds.');
const MAP_B = { old: 'b.md', new: ['cache-ttl.md'], primary: 'cache-ttl.md' };
const MAP_PROJECT = { old: 'project.md', new: ['db-migrations.md'], primary: 'db-migrations.md', dropped: [{ what: 'the zebra rule', why: 'stale' }] };

function chatStub(): ChatApi {
  const chat: Partial<ChatApi> = {
    openWithPrompt(req, prompt, opts) {
      const tabId = `tab-${opened.length + 1}`;
      opened.push({ req, prompt, opts, tabId });
      return { tabId, cwd: req.cwd ?? '', title: req.title ?? '' };
    },
    get: (tabId) => ({ send: (r) => void sent.push({ tabId, text: r.text ?? '' }), pendingPermission: () => null }),
  };
  return chat as ChatApi;
}

// Project p: two old-format notes and MEMORY.md. Project q links [[project]] from another project.
function start(setup?: () => void): void {
  kit.addProject('p', rootOf('p'));
  kit.addProject('q', rootOf('q'));
  kit.write(note('p', 'project.md'), OLD_PROJECT);
  kit.write(note('p', 'b.md'), OLD_B);
  kit.write(note('p', 'MEMORY.md'), OLD_MEMORY);
  kit.write(note('q', 'q-links.md'), Q_LINKS);
  kit.write(join(kit.paths.root, 'NOTE_RULES.md'), '# Note rules\nOne fact per note.\n');
  setup?.();
  kit.ctx.chat = chatStub();
  registerMemory(kit.ctx);
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const r = await kit.app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.json() as T };
}

const runDir = (v: WikiRunView) => join(kit.paths.vault, '.wiki-migration', v.project, v.run);
const batchDir = (v: WikiRunView, n: number) => join(runDir(v), String(n));
const finish = (tabId: string) => kit.ctx.bus.emit('turn-finished', tabId);
const view = async (key = 'p') => (await call<WikiRunView>('GET', `/api/memory/wiki/${key}`)).body;

function writeBatch(v: WikiRunView, n: number, out: Record<string, string>, map: unknown): void {
  for (const [file, text] of Object.entries(out)) kit.write(join(batchDir(v, n), 'out', file), text);
  kit.write(join(batchDir(v, n), 'map.json'), JSON.stringify(map));
}

// Prepared, rewritten by "Claude" in one batch and verified.
async function ready(setup?: () => void): Promise<WikiRunView> {
  start(setup);
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  writeBatch(v, 1, { 'db-migrations.md': DB, 'cache-ttl.md': CACHE }, [MAP_B, MAP_PROJECT]);
  finish(opened.at(-1)!.tabId);
  const after = await view();
  assert.equal(after.state, 'ready', JSON.stringify(after.batches));
  return after;
}

function backupsOf(path: string): string[] {
  const dir = join(kit.paths.data, 'backups');
  return safely(() => readdirSync(dir), []).map((stamp) => read(join(dir, stamp, path))).filter((t) => t !== null);
}

const size = (text: string) => ({ lines: text.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').length, bytes: Buffer.byteLength(text), tokens: Math.ceil(Buffer.byteLength(text) / 4) });

test('split batches at 60 KB, a big file alone', () => {
  const files = [
    { file: 'e.md', bytes: 10 },
    { file: 'a.md', bytes: 30_000 },
    { file: 'd.md', bytes: 70_000 },
    { file: 'b.md', bytes: 30_000 },
    { file: 'c.md', bytes: 1_000 },
  ];
  assert.deepEqual(splitBatches(files), [['a.md', 'b.md'], ['c.md'], ['d.md'], ['e.md']]);
  assert.deepEqual(splitBatches([]), []);
});

test('prepare backs up, writes the brief, opens batch 1 and leaves notes unchanged', async () => {
  start(() => kit.write(note('q', 'other-fact.md'), wiki('other-fact', 'Some other fact', 'Body.', 'infra')));
  const { status, body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  assert.equal(status, 200, JSON.stringify(v));
  assert.equal(v.state, 'rewriting');
  assert.deepEqual(v.batches.map((b) => [b.n, b.files, b.status, b.tabId]), [[1, ['b.md', 'project.md'], 'running', 'tab-1']]);
  for (const [file, text] of [['project.md', OLD_PROJECT], ['b.md', OLD_B], ['MEMORY.md', OLD_MEMORY]]) {
    assert.deepEqual(backupsOf(note('p', file)), [text], file);
    assert.equal(read(note('p', file)), text);
  }
  const brief = join(batchDir(v, 1), 'brief.md');
  const text = read(brief)!;
  assert.match(text, /One fact per note\./);
  assert.ok(text.includes(note('p', 'project.md')) && text.includes(note('p', 'b.md')));
  assert.ok(!text.includes(note('p', 'MEMORY.md')));
  assert.ok(text.includes(join(batchDir(v, 1), 'out')) && text.includes(join(batchDir(v, 1), 'map.json')));
  assert.match(text, /other-fact/);
  assert.match(text, /keep code spans, URLs, paths and numbers verbatim/i);
  assert.match(text, /reply done after map\.json/i);
  assert.deepEqual(opened.map((o) => [o.req, o.prompt, o.opts]), [[
    { project: 'p', cwd: rootOf('p'), title: 'Wiki migration: p 1/1' },
    `Wiki migration of p, batch 1/1. Read ${brief} and follow it.`,
    { focus: false },
  ]]);
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
});

test('a failed batch gets the exact list, two failed fix-ups mark it failed', async () => {
  start();
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  writeBatch(v, 1, { 'bad-note.md': 'no frontmatter here\n' }, [{ old: 'project.md', new: ['bad-note.md'], primary: 'bad-note.md' }]);
  finish('tab-1');
  const after = await view();
  const errors = after.batches[0].errors;
  assert.ok(errors.includes('b.md is missing from map.json; add one entry for it'), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('bad-note.md: note has no frontmatter')), errors.join('\n'));
  assert.deepEqual(sent, [{ tabId: 'tab-1', text: `Verification failed:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix these in ${batchDir(v, 1)} and reply done.` }]);
  assert.equal(after.batches[0].status, 'running');
  finish('tab-1');
  assert.equal(sent.length, 2);
  finish('tab-1');
  assert.equal(sent.length, 2);
  const failed = await view();
  assert.equal(failed.batches[0].status, 'failed');
  assert.equal(failed.state, 'failed');
});

test('an ok batch opens the next, the last makes a preview', async () => {
  start(() => {
    kit.write(note('p', 'b.md'), OLD_B + 'pad '.repeat(4_000));
    kit.write(note('p', 'project.md'), OLD_PROJECT + 'lorem '.repeat(8_500));
  });
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  assert.deepEqual(v.batches.map((b) => b.files), [['b.md'], ['project.md']]);
  writeBatch(v, 1, { 'cache-ttl.md': CACHE }, [MAP_B]);
  finish('tab-1');
  const mid = await view();
  assert.deepEqual(mid.batches.map((b) => b.status), ['ok', 'running']);
  assert.equal(opened[1].req.title, 'Wiki migration: p 2/2');
  assert.equal(mid.preview, null);
  writeBatch(v, 2, { 'db-migrations.md': DB }, [MAP_PROJECT]);
  finish('tab-2');
  const done = await view();
  assert.equal(done.state, 'ready', JSON.stringify(done.batches));
  const p = done.preview!;
  assert.deepEqual(p.files, [
    { old: 'b.md', new: ['cache-ttl.md'], dropped: [] },
    { old: 'project.md', new: ['db-migrations.md'], dropped: [{ what: 'the zebra rule', why: 'stale' }] },
  ]);
  assert.deepEqual(p.memory.before, size(OLD_MEMORY));
  const after = '## project\n- [cache-ttl](cache-ttl.md) — How long the cache keeps entries\n- [db-migrations](db-migrations.md) — How migrations are made\n';
  assert.deepEqual(p.memory.after, size(after));
  assert.equal(p.notesAfter, 2);
  assert.match(p.linkDiff, /projects\/q\/q-links\.md/);
  assert.match(p.linkDiff, /^-See \[\[project\]\] for the db rules\.$/m);
  assert.match(p.linkDiff, /^\+See \[\[db-migrations\]\] for the db rules\.$/m);
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS, 'the preview changes nothing');
});

test('apply moves, writes, rewrites links across projects, regenerates, logs and audits', async () => {
  const v = await ready();
  const { status, body } = await call<WikiRunView>('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.state, 'applied');
  assert.deepEqual(readdirSync(projDir('p')).sort(), ['MEMORY.md', 'cache-ttl.md', 'db-migrations.md']);
  assert.equal(read(note('p', 'db-migrations.md')), DB);
  assert.equal(read(join(runDir(v), 'old', 'project.md')), OLD_PROJECT);
  assert.equal(read(join(runDir(v), 'old', 'b.md')), OLD_B);
  assert.equal(read(join(runDir(v), 'old', 'MEMORY.md')), OLD_MEMORY);
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS.replace('[[project]]', '[[db-migrations]]'));
  assert.deepEqual(backupsOf(note('q', 'q-links.md')), [Q_LINKS]);
  assert.match(read(note('p', 'MEMORY.md'))!, /^- \[db-migrations\]\(db-migrations\.md\) — How migrations are made$/m);
  assert.ok(existsSync(join(kit.paths.vault, '_index', 'p.md')));
  assert.match(read(join(kit.paths.vault, '_log', 'p.md'))!, /^\d{4}-\d{2}-\d{2} migrate p /m);
  const audit = kit.audits.find((a) => a.action === 'memory.wiki');
  assert.equal(audit?.target, projDir('p'));
  assert.match(audit!.diff!, /^\+See \[\[db-migrations\]\]/m);
  assert.equal(isWikiManaged(kit.paths, 'p'), true);
  assert.deepEqual(Object.fromEntries(migratedSources(kit.paths, 'p')), {
    'MEMORY.md': sha256(OLD_MEMORY),
    'b.md': sha256(OLD_B),
    'project.md': sha256(OLD_PROJECT),
  });
});

test('apply logs no delete lines for the moved inputs', async () => {
  await ready();
  await sleep(300); // the watcher is ready
  assert.equal((await call('POST', '/api/memory/wiki/p/apply', { connect: false })).status, 200);
  await sleep(800); // past the watcher's 300 ms debounce
  const log = read(join(kit.paths.vault, '_log', 'p.md'))!;
  assert.match(log, / migrate p /);
  assert.doesNotMatch(log, / delete /, log);
});

test('a same-named note in another project keeps its own links', async () => {
  const own = wiki('project-q', 'q has its own project note', 'Q facts.', 'infra');
  await ready(() => kit.write(note('q', 'project.md'), own));
  const { status } = await call('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(status, 200);
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS);
  assert.equal(read(note('q', 'project.md')), own);
});

test('apply then undo restores byte-identical notes and keeps a changed new note', async () => {
  const v = await ready();
  await call('POST', '/api/memory/wiki/p/apply', { connect: false });
  const changed = CACHE + 'Edited after the migration.\n';
  kit.write(note('p', 'cache-ttl.md'), changed);
  const { status, body } = await call<{ restored: string[]; kept: string[]; conflicts: string[] }>('POST', '/api/memory/wiki/p/undo');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.kept, ['cache-ttl.md']);
  assert.deepEqual(body.conflicts, []);
  for (const f of ['project.md', 'b.md', 'MEMORY.md']) assert.ok(body.restored.includes(f), f);
  assert.equal(read(note('p', 'project.md')), OLD_PROJECT);
  assert.equal(read(note('p', 'b.md')), OLD_B);
  assert.equal(read(note('p', 'MEMORY.md')), OLD_MEMORY);
  assert.equal(existsSync(note('p', 'db-migrations.md')), false);
  assert.equal(read(note('p', 'cache-ttl.md')), changed);
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS);
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
  assert.equal(existsSync(join(kit.paths.vault, '_index', 'p.md')), false);
  assert.equal(migratedSources(kit.paths, 'p').size, 0);
  assert.equal((await view()).state, 'undone');
  assert.equal(read(join(runDir(v), 'old', 'project.md')), OLD_PROJECT, 'the staging copy stays');
  assert.equal((await call('POST', '/api/memory/wiki/p/undo')).status, 409);
});

test('apply refuses when an input changed', async () => {
  await ready();
  kit.write(note('p', 'b.md'), OLD_B + 'Changed by another session.\n');
  const { status, body } = await call<{ error: string }>('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(status, 409);
  assert.match(body.error, /b\.md/);
  assert.ok(!body.error.includes('project.md'));
  assert.equal(read(note('p', 'project.md')), OLD_PROJECT);
  assert.equal(existsSync(note('p', 'db-migrations.md')), false);
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS);
  assert.equal((await view()).state, 'ready');
});

test('prepare copies the old-place drift in first: it is an input', async () => {
  const mem = join(kit.paths.claudeDir, 'projects', encodeDir(rootOf('p')), 'memory');
  start(() => kit.write(join(mem, 'drift-fact.md'), OLD_B));
  const { status, body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  assert.equal(status, 200, JSON.stringify(v));
  assert.deepEqual(v.batches[0].files, ['b.md', 'drift-fact.md', 'project.md']);
  assert.equal(read(note('p', 'drift-fact.md')), OLD_B);
});

test('a note added during the run is kept as is; a name the run writes is refused', async () => {
  const added = wiki('added-fact', 'A fact written during the run', 'Added.');
  start();
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  kit.write(note('p', 'added-fact.md'), added); // before the preview
  writeBatch(v, 1, { 'db-migrations.md': DB, 'cache-ttl.md': CACHE }, [MAP_B, MAP_PROJECT]);
  finish('tab-1');
  const r = await view();
  assert.equal(r.state, 'ready', JSON.stringify(r.batches));
  assert.ok(r.preview!.warnings.includes('added-fact.md: added after prepare, kept as is'), r.preview!.warnings.join('\n'));
  kit.write(note('p', 'late-fact.md'), wiki('late-fact', 'A fact written after the preview', 'Late.')); // after the preview
  kit.write(note('p', 'cache-ttl.md'), CACHE);
  const refused = await call<{ error: string }>('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /cache-ttl\.md/);
  assert.ok(!refused.body.error.includes('added-fact.md'), refused.body.error);
  rmSync(note('p', 'cache-ttl.md'));
  const { status, body } = await call<WikiRunView>('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(readdirSync(projDir('p')).sort(), ['MEMORY.md', 'added-fact.md', 'cache-ttl.md', 'db-migrations.md', 'late-fact.md']);
  assert.equal(read(note('p', 'added-fact.md')), added);
  assert.match(read(note('p', 'MEMORY.md'))!, /\[added-fact\]\(added-fact\.md\)/);
});

test('an input cannot be edited while its run rewrites or waits for apply', async () => {
  start();
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  const g = (tool: string, path: string, extra: Record<string, unknown>) => kit.ctx.memory.guardTool('tab-other', rootOf('p'), tool, { file_path: path, ...extra });
  const reason = 'projects/p/b.md is being rewritten by the wiki migration of p: put the change in a new note, or edit this one after the migration is applied or discarded';
  assert.deepEqual(g('Edit', note('p', 'b.md'), { old_string: 'Cache', new_string: 'The cache' }), { decision: 'deny', reason });
  assert.equal(g('Write', note('p', 'b.md'), { content: OLD_B })?.decision, 'deny');
  assert.equal(g('Read', note('p', 'b.md'), {}), null);
  assert.equal(g('Write', note('p', 'new-fact.md'), { content: wiki('new-fact', 'A new fact', 'Body.') }), null, 'a new note is fine');
  writeBatch(v, 1, { 'db-migrations.md': DB, 'cache-ttl.md': CACHE }, [MAP_B, MAP_PROJECT]);
  finish('tab-1');
  assert.equal((await view()).state, 'ready');
  assert.equal(g('Edit', note('p', 'b.md'), { old_string: 'Cache', new_string: 'The cache' })?.decision, 'deny');
  assert.equal((await call('DELETE', '/api/memory/wiki/p')).status, 200);
  assert.equal(g('Edit', note('p', 'b.md'), { old_string: 'Cache', new_string: 'The cache' }), null, 'a discarded run frees its inputs');
});

test('an error during apply restores the backup', async () => {
  const v = await ready();
  mkdirSync(note('p', 'db-migrations.md')); // the new note cannot be written there
  const { status } = await call('POST', '/api/memory/wiki/p/apply', { connect: false });
  assert.equal(status, 500);
  assert.equal(read(note('p', 'project.md')), OLD_PROJECT);
  assert.equal(read(note('p', 'b.md')), OLD_B);
  assert.equal(read(note('p', 'MEMORY.md')), OLD_MEMORY);
  assert.equal(existsSync(note('p', 'cache-ttl.md')), false);
  assert.ok(statSync(note('p', 'db-migrations.md')).isDirectory());
  assert.equal(read(note('q', 'q-links.md')), Q_LINKS);
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
  assert.equal(existsSync(join(kit.paths.vault, '_index', 'p.md')), false);
  assert.deepEqual(safely(() => readdirSync(join(runDir(v), 'old')), []), []);
  assert.equal(migratedSources(kit.paths, 'p').size, 0);
  assert.equal((await view()).state, 'ready');
});

test('after apply no path copies a migrated source back', async () => {
  const mem = join(kit.paths.claudeDir, 'projects', encodeDir(rootOf('p')), 'memory');
  const v = await ready(() => {
    kit.write(join(mem, 'project.md'), OLD_PROJECT);
    kit.write(join(mem, 'b.md'), OLD_B + 'Edited in the old place after the copy.\n'); // the vault copy won
    kit.write(join(mem, 'MEMORY.md'), OLD_MEMORY);
  });
  kit.write(join(mem, 'extra.md'), 'Only in the old place.\n'); // a terminal session wrote it after prepare
  assert.ok(v.preview!.warnings.some((w) => w.startsWith('b.md: the old-place copy differs')), v.preview!.warnings.join('\n'));
  assert.equal((await call('POST', '/api/memory/wiki/p/apply', { connect: false })).status, 200);
  const { body: preview } = await call<VaultCopyPreview>('GET', '/api/memory/vault/p');
  assert.deepEqual(preview.newFiles, ['extra.md']);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(kit.ctx.memory.projectStats('p').drift, 1);
  const { body: plan } = await call<MemoryMigrationPlan>('GET', '/api/memory/migrate/p');
  assert.deepEqual(plan.files, ['extra.md']);
  assert.equal(kit.ctx.memory.search('zebra').length, 0);
  const { body: graph } = await call<MemoryGraph>('GET', '/api/memory/graph');
  assert.ok(!graph.nodes.some((n) => ['project.md', 'b.md'].includes(n.file)), JSON.stringify(graph.nodes.map((n) => n.file)));
  const { body: copied } = await call<{ copied: number }>('POST', '/api/memory/vault/copy');
  assert.equal(copied.copied, 1);
  assert.equal(existsSync(note('p', 'project.md')), false);
  assert.equal(existsSync(note('p', 'b.md')), false);
  assert.equal(kit.ctx.memory.projectStats('p').drift, 0);
});

test('connect writes autoMemoryDirectory, unchecked leaves settings', async () => {
  const mem = join(kit.paths.claudeDir, 'projects', encodeDir(rootOf('p')), 'memory');
  await ready(() => {
    kit.write(join(mem, 'project.md'), OLD_PROJECT);
    kit.write(join(mem, 'b.md'), OLD_B);
    kit.write(join(mem, 'MEMORY.md'), OLD_MEMORY);
  });
  const settings = join(rootOf('p'), '.claude', 'settings.local.json');
  assert.equal((await call('POST', '/api/memory/wiki/p/apply', { connect: false })).status, 200);
  assert.equal(existsSync(settings), false);
  assert.equal((await call('POST', '/api/memory/wiki/p/undo')).status, 200);

  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  writeBatch(v, 1, { 'db-migrations.md': DB, 'cache-ttl.md': CACHE }, [MAP_B, MAP_PROJECT]);
  finish(opened.at(-1)!.tabId);
  assert.equal((await view()).state, 'ready');
  const { status, body } = await call<WikiRunView>('POST', '/api/memory/wiki/p/apply', { connect: true });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(JSON.parse(read(settings)!).autoMemoryDirectory, projDir('p'));
  assert.deepEqual(readdirSync(projDir('p')).sort(), ['MEMORY.md', 'cache-ttl.md', 'db-migrations.md'], 'no migrated original came back');
  assert.match(read(note('p', 'MEMORY.md'))!, /db-migrations/);
});

test('a connect error after the notes moved puts back the notes and the run', async () => {
  await ready();
  mkdirSync(join(rootOf('p'), '.claude', 'settings.local.json'), { recursive: true }); // the settings cannot be written
  const { status } = await call('POST', '/api/memory/wiki/p/apply', { connect: true });
  assert.equal(status, 500);
  assert.equal(read(note('p', 'project.md')), OLD_PROJECT);
  assert.equal(existsSync(note('p', 'db-migrations.md')), false);
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
  assert.equal(migratedSources(kit.paths, 'p').size, 0);
  assert.equal((await view()).state, 'ready');
  assert.equal((await call('POST', '/api/memory/wiki/p/apply', { connect: false })).status, 200, 'the run can still be applied');
});

test('a fifth concurrent run is refused', async () => {
  kit.ctx.chat = chatStub();
  for (const key of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    kit.addProject(key, rootOf(key));
    kit.write(note(key, 'some-fact.md'), wiki('some-fact', 'A fact', 'Body.'));
  }
  registerMemory(kit.ctx);
  for (const key of ['p1', 'p2', 'p3', 'p4']) assert.equal((await call('POST', `/api/memory/wiki/${key}/prepare`)).status, 200, key);
  const fifth = await call<{ error: string }>('POST', '/api/memory/wiki/p5/prepare');
  assert.equal(fifth.status, 409);
  assert.equal(opened.length, 4);
  assert.equal((await call('POST', '/api/memory/wiki/p1/prepare')).status, 409, 'one run per project');
});

test('an empty project becomes managed through apply with zero notes', async () => {
  kit.ctx.chat = chatStub();
  kit.addProject('e', rootOf('e'));
  registerMemory(kit.ctx);
  const { status, body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/e/prepare');
  assert.equal(status, 200, JSON.stringify(v));
  assert.equal(v.state, 'ready');
  assert.deepEqual(v.batches, []);
  assert.equal(v.preview?.notesAfter, 0);
  assert.equal(opened.length, 0);
  const applied = await call<WikiRunView>('POST', '/api/memory/wiki/e/apply', { connect: false });
  assert.equal(applied.body.state, 'applied', JSON.stringify(applied.body));
  assert.equal(isWikiManaged(kit.paths, 'e'), true);
});

test('a migration tab writes only to its batch dir', async () => {
  start();
  const { body: v } = await call<WikiRunView>('POST', '/api/memory/wiki/p/prepare');
  const dir = batchDir(v, 1);
  const g = (tool: string, path: string, extra: Record<string, unknown> = {}, tab = 'tab-1') =>
    kit.ctx.memory.guardTool(tab, rootOf('p'), tool, { file_path: path, ...extra });
  assert.equal(g('Read', note('p', 'b.md'))?.decision, 'allow');
  assert.equal(g('Read', join(dir, 'brief.md'))?.decision, 'allow');
  assert.equal(g('Read', note('q', 'q-links.md'))?.decision, 'deny');
  assert.equal(g('Read', join(kit.paths.root, 'NOTE_RULES.md')), null);
  assert.equal(g('Write', join(dir, 'out', 'cache-ttl.md'), { content: CACHE })?.decision, 'allow');
  const bad = g('Write', join(dir, 'out', 'bad-note.md'), { content: 'no frontmatter\n' });
  assert.equal(bad?.decision, 'deny');
  assert.match(bad!.reason, /no frontmatter/);
  assert.equal(g('Write', join(dir, 'map.json'), { content: '[]' })?.decision, 'allow');
  const elsewhere = g('Write', note('p', 'x-fact.md'), { content: wiki('x-fact', 'A fact', 'Body.') });
  assert.deepEqual(elsewhere, { decision: 'deny', reason: `during the wiki migration write only to ${dir}` });
  assert.equal(g('Edit', join(dir, 'brief.md'), { old_string: 'Wiki', new_string: 'X' })?.decision, 'deny');
  assert.equal(g('Write', join(kit.base, 'elsewhere.ts'), { content: 'x' }), null);
  assert.equal(g('Write', note('p', 'x-fact.md'), { content: wiki('x-fact', 'A fact', 'Body.') }, 'tab-other'), null, 'other tabs keep the normal rules');

  assert.equal((await call('DELETE', '/api/memory/wiki/p')).status, 200);
  assert.equal(existsSync(runDir(v)), false);
  assert.equal(await view(), null);
  assert.equal(g('Write', note('p', 'x-fact.md'), { content: wiki('x-fact', 'A fact', 'Body.') }), null, 'a discarded run frees its tab');
});
