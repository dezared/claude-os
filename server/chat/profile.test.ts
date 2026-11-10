import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveClaudeBin } from '../context.ts';
import { kanbanColumnLabels, profileBlock, progressStatusLabels, promptKindOf, promptLabels, PROMPT_LABELS, QUESTION_LEVELS, sessionProfileBlock } from './profile.ts';
import type { QuestionLevel } from '../../shared/contract.ts';
import { createRootMcp } from './rootMcp.ts';
import { strings as enStrings } from '../../web/src/lib/locales/en.ts';
import { strings as ruStrings } from '../../web/src/lib/locales/ru.ts';

test('profileBlock names the user, language and question level', () => {
  const block = profileBlock({ name: 'Ann', language: 'de', questionLevel: 'minimal', projectsDir: '/p' }, { 'root tab': 'Start' });
  assert.equal(block, [
    '# The user',
    "The user's name is Ann. Reply in German (de).",
    `Question level: minimal. ${QUESTION_LEVELS.minimal}`,
    'UI labels as the user sees them. Use these when you name an element:',
    '- root tab: "Start"',
  ].join('\n'));
  assert.match(profileBlock({ name: 'Ann', language: 'qqq', questionLevel: 'balanced', projectsDir: '/p' }, {}), /Reply in qqq\./, 'an unknown code stays a code');
});

test('each level has its own block under 400 bytes', () => {
  const levels = Object.keys(QUESTION_LEVELS) as QuestionLevel[];
  const blocks = levels.map((questionLevel) => profileBlock({ name: 'Ann', language: 'en', questionLevel, projectsDir: '/p' }, {}));
  levels.forEach((level, i) => {
    assert.ok(blocks[i].includes(`Question level: ${level}. ${QUESTION_LEVELS[level]}`), blocks[i]);
    assert.ok(Buffer.byteLength(QUESTION_LEVELS[level]) + 40 <= 400, `${level}: ${Buffer.byteLength(QUESTION_LEVELS[level])} B`);
  });
  assert.equal(new Set(blocks).size, levels.length);
});

test('profileBlock is empty without a profile', () => {
  assert.equal(profileBlock(null, { 'root tab': 'Home' }), '');
});

test('promptLabels: the active catalog, en for a language without one', () => {
  const all = Object.keys(PROMPT_LABELS).join('\n');
  const ru = promptLabels('ru', all);
  const de = promptLabels('de', all);
  assert.deepEqual(Object.keys(ru), Object.keys(PROMPT_LABELS));
  assert.equal(de['root tab'], 'Home');
  assert.equal(de['"Edit with Claude" button of a document'], 'Edit with Claude');
  assert.notEqual(ru['root tab'], 'Home');
});

test('every label the prompts mention is in both catalogs', () => {
  const missing = Object.values(PROMPT_LABELS).filter((key) => !(key in ruStrings) || !(key in enStrings));
  assert.deepEqual(missing, []);
  assert.equal(promptLabels('ru', 'the Tools screen')['Tools screen'], ruStrings['nav.tools']);
});

const REPO = join(import.meta.dirname, '../..');
const PATHS = { root: join(REPO, 'root'), service: join(REPO, 'service'), setup: join(REPO, 'setup') };

test('work tab profile block lists no labels', () => {
  const ctx = { paths: PATHS, settings: { profile: () => ({ name: 'Ann', language: 'en', questionLevel: 'balanced', projectsDir: '/p' }) } };
  const block = sessionProfileBlock(ctx as never, 'work');
  assert.match(block, /Ann/);
  assert.deepEqual(block.split('\n').filter((l) => l.startsWith('- ')), []);
  assert.doesNotMatch(block, /UI labels/);
  assert.match(sessionProfileBlock(ctx as never, 'root'), /^- root tab: "Home"$/m);
});

test('root block lists only labels its prompts name', () => {
  assert.deepEqual(promptLabels('en', 'open the Projects screen'), { 'Projects screen': enStrings['nav.projects'] });
});

test('kanban labels follow the user\'s language', () => {
  const ru = kanbanColumnLabels('ru');
  assert.ok(ru.includes(`backlog "${ruStrings['kanban.backlog']}"`), ru);
  for (const column of ['backlog', 'todo', 'doing', 'polish', 'done']) assert.ok(ru.includes(`${column} "`), column);
  assert.equal(kanbanColumnLabels('de'), kanbanColumnLabels('en'));
  assert.ok(progressStatusLabels('ru').includes(`waiting "${ruStrings['progress.waiting']}"`));
});

test('promptKindOf: root and service by kind, the setup folder, the rest work', () => {
  const row = (kind: string, cwd: string) => ({ kind, cwd });
  assert.equal(promptKindOf(PATHS as never, row('root', PATHS.root)), 'root');
  assert.equal(promptKindOf(PATHS as never, row('service', PATHS.service)), 'service');
  assert.equal(promptKindOf(PATHS as never, row('work', PATHS.setup)), 'setup');
  assert.equal(promptKindOf(PATHS as never, row('work', join(PATHS.setup, 'x'))), 'setup');
  assert.equal(promptKindOf(PATHS as never, row('work', `${PATHS.setup}-other`)), 'work');
  assert.equal(promptKindOf(PATHS as never, row('document', REPO)), 'work');
});

test('resolveClaudeBin order', () => {
  const base = { env: {}, pathEnv: '/a:/b', platform: 'linux' as const, home: '/h' };
  assert.equal(resolveClaudeBin({ ...base, env: { CLAUDE_OS_CLAUDE_BIN: '/x/claude' }, exists: () => true }), '/x/claude');
  assert.equal(resolveClaudeBin({ ...base, exists: (p) => p === '/b/claude' }), '/b/claude');
  assert.equal(resolveClaudeBin({ ...base, exists: () => false }), '/h/.local/bin/claude');
  const win = { env: {}, pathEnv: 'C:\\a;C:\\b', platform: 'win32' as const, home: 'C:\\h' };
  assert.equal(resolveClaudeBin({ ...win, exists: (p) => p === 'C:\\b\\claude.cmd' }), 'C:\\b\\claude.cmd');
  assert.equal(resolveClaudeBin({ ...win, exists: (p) => p === 'C:\\b\\claude.exe' || p === 'C:\\b\\claude.cmd' }), 'C:\\b\\claude.exe');
  assert.equal(resolveClaudeBin({ ...base, exists: (p) => p === '/a/claude.exe' }), '/h/.local/bin/claude', 'claude.exe counts on win32 only');
  assert.equal(resolveClaudeBin({ ...win, exists: () => false }), 'C:\\h\\.local\\bin\\claude.exe');
});

test('create_project: CLAUDE_OS_NEW_PROJECTS, then the profile folder, then the default', async () => {
  const base = mkdtempSync(join(tmpdir(), 'claude-os-profile-'));
  const saved = process.env.CLAUDE_OS_NEW_PROJECTS;
  let profile: { projectsDir: string } | null = { projectsDir: join(base, 'mine') };
  const ctx = { paths: { newProjectsDir: join(base, 'default'), data: join(base, 'data'), config: join(base, 'config'), root: join(base, 'root'), vault: join(base, 'vault'), repo: base }, settings: { profile: () => profile }, journal: { listProjects: () => [] }, audit: () => {}, invalidate: () => {} };
  const server = createRootMcp(ctx as never, { openWithPrompt: (o: object) => o } as never, 'tab-root', 'root');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const create = (name: string) => client.callTool({ name: 'create_project', arguments: { name, prompt: 'x' } });
  try {
    delete process.env.CLAUDE_OS_NEW_PROJECTS;
    await create('one');
    assert.ok(existsSync(join(base, 'mine', 'one')));
    profile = null;
    await create('two');
    assert.ok(existsSync(join(base, 'default', 'two')));
    profile = { projectsDir: join(base, 'mine') };
    process.env.CLAUDE_OS_NEW_PROJECTS = join(base, 'default');
    await create('three');
    assert.ok(existsSync(join(base, 'default', 'three')), 'the env var wins over the profile');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_OS_NEW_PROJECTS;
    else process.env.CLAUDE_OS_NEW_PROJECTS = saved;
    await client.close();
    rmSync(base, { recursive: true, force: true });
  }
});
