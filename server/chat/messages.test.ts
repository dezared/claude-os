// What a person reads from the server goes through the web catalogs: an English message for everything else, a key for the UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import { DENY_TEXTS, type Tab } from '../../shared/contract.ts';
import { findViolations } from '../../scripts/check-shippable.ts';
import { strings as en } from '../../web/src/lib/locales/en.ts';
import { strings as ru } from '../../web/src/lib/locales/ru.ts';
import { tabTitle } from '../../web/src/lib/tabTitle.ts';
import { startServer, type TestServer } from './fixtures/harness.ts';

const REPO = join(import.meta.dirname, '../..');
const FILES = [
  'server/chat/session.ts',
  'server/index.ts',
  'server/chat/manager.ts',
  'server/chat/index.ts',
  'server/journal/parse.ts',
  'server/chat/btw.ts',
  'server/memory/state.ts',
  'server/tools/documents.ts',
  'shared/contract.ts',
  'web/src/lib/api.ts',
  'web/src/lib/chat.ts',
  'web/src/work/voice/pcm.ts',
  'server/voice/engine.ts',
  'web/src/work/mentionSources.ts',
  'web/src/lib/tabTitle.ts',
  'server/chat/serviceTasks.ts',
  'server/chat/terminal.ts',
  'server/journal/indexer.ts',
  'server/tools/actions.ts',
  'server/tools/commands.ts',
  'web/src/work/ToolCall.tsx',
];
const codeOf = (line: string) => line.replace(/^\s*(?:\/\/|\/\*\*?|\*).*$/, '').replace(/\s\/\/\s.*$/, '');

test('no Russian in user-visible server messages', () => {
  const files = FILES.map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') }));
  const lines = files.map(({ path, text }) => ({ path, lines: text.split('\n') }));
  const left = findViolations(files, [])
    .filter((v) => v.rule === 'cyrillic')
    .map((v) => ({ ...v, raw: lines.find((f) => f.path === v.path)!.lines[v.line - 1] }))
    .filter((v) => /\p{Script=Cyrillic}/u.test(codeOf(v.raw)))
    .map((v) => `${v.path}:${v.line} ${v.excerpt}`);
  assert.deepEqual(left, []);
});

test('every message key the server sends is in both catalogs', () => {
  const keys = new Set<string>();
  for (const path of FILES.filter((p) => p.startsWith('server/'))) {
    const text = readFileSync(join(REPO, path), 'utf8');
    for (const m of text.matchAll(/[Hh]ttpError\(\d+, (?:'[^']*'|`[^`]*`), '(\w+)'/g)) keys.add(m[1]);
    for (const m of text.matchAll(/[kK]ey: ([^,}\n]*'[^,}\n]*)/g)) for (const k of m[1].matchAll(/'(\w+)'/g)) keys.add(k[1]);
    for (const m of text.matchAll(/[kK]ey = '(\w+)'/g)) keys.add(m[1]);
    for (const m of text.matchAll(/\bsay\(.*, '(\w+)'/g)) keys.add(m[1]);
  }
  for (const key of Object.keys(DENY_TEXTS)) keys.add(key);
  assert.ok(keys.size > 60, `found ${keys.size} keys`);
  const missing = [...keys].flatMap((k) => [`ru:${k}`, `en:${k}`]).filter((k) => {
    const [lang, key] = k.split(':');
    return !((lang === 'ru' ? ru : en) as Record<string, string>)[`errors.${key}`];
  });
  assert.deepEqual(missing, []);
});

test('the ru and en catalogs have the same keys, but for the Russian plural forms', () => {
  const ruKeys = Object.keys(ru).filter((k) => !/\.(few|many)$/.test(k)).sort();
  assert.deepEqual(Object.keys(en).sort(), ruKeys);
});

test('root tab title follows the UI language', () => {
  const root = (title: string) => ({ kind: 'root' as const, title });
  assert.equal(tabTitle(root('Главная'), 'Home'), 'Home');
  assert.equal(tabTitle(root('Home'), 'Главная'), 'Главная');
  assert.equal(tabTitle(root('Мой центр'), 'Home'), 'Мой центр', 'a rename stays as typed');
  assert.equal(tabTitle({ kind: 'work', title: 'Home' }, 'Главная'), 'Home', 'only the root tab');
});

describe('over the server', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.destroy();
  });

  it('HttpError carries key and params to the response', async () => {
    const missing = await srv.api('POST', '/api/tabs/nope/interrupt');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Tab not found', key: 'tabNotFound' });
    const dir = join(srv.dir, 'no-such-dir');
    const absent = await srv.api('POST', '/api/tabs', { cwd: dir });
    assert.equal(absent.status, 400);
    assert.deepEqual(absent.body, { error: `Directory does not exist: ${dir}`, key: 'dirMissing', params: { cwd: dir } });
  });

  it('a new root tab is titled Home', async () => {
    const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
    assert.equal(root.title, 'Home');
  });
});
