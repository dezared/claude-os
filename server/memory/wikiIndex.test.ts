import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeKit } from './testkit.ts';
import { appendLog, MEMORY_BUDGET, renderCatalog, renderMemoryIndex, type IndexNote } from './wikiIndex.ts';

const note = (name: string, over: Partial<IndexNote> = {}): IndexNote => ({
  name,
  file: `${name}.md`,
  description: `what ${name} answers`,
  summary: null,
  type: 'project',
  tags: [],
  recency: 0,
  ...over,
});

test('sections in type order, names sorted, empty sections omitted', () => {
  const out = renderMemoryIndex('demo', [
    note('zeta', { type: 'reference' }),
    note('beta', { type: 'user' }),
    note('alpha', { type: 'user' }),
    note('gamma', { type: null }),
    note('delta', { type: 'weird' }),
  ]);
  assert.equal(out, [
    '## user',
    '- [alpha](alpha.md) — what alpha answers',
    '- [beta](beta.md) — what beta answers',
    '## project',
    '- [delta](delta.md) — what delta answers',
    '- [gamma](gamma.md) — what gamma answers',
    '## reference',
    '- [zeta](zeta.md) — what zeta answers',
    '',
  ].join('\n'));
  assert.ok(!out.startsWith('---'), 'no frontmatter');
});

test('300 notes stay within 100 lines and 10,000 bytes', () => {
  const notes: IndexNote[] = [];
  const desc = (i: number) => `a fairly long description of note number ${i} that answers one question`;
  for (let i = 0; i < 40; i++) notes.push(note(`user-${String(i).padStart(3, '0')}`, { type: 'user', description: desc(i), recency: i }));
  for (let i = 0; i < 80; i++) notes.push(note(`feedback-${String(i).padStart(3, '0')}`, { type: 'feedback', description: desc(i), recency: i }));
  for (let i = 0; i < 180; i++) notes.push(note(`project-${String(i).padStart(3, '0')}`, { type: 'project', description: desc(i), recency: 1000 + i }));
  const out = renderMemoryIndex('demo', notes);
  const lines = out.replace(/\n$/, '').split('\n');
  assert.ok(lines.length <= MEMORY_BUDGET.lines, `${lines.length} lines`);
  assert.ok(Buffer.byteLength(out) <= MEMORY_BUDGET.bytes, `${Buffer.byteLength(out)} bytes`);
  for (let i = 0; i < 40; i++) assert.ok(out.includes(`[user-${String(i).padStart(3, '0')}]`), `user ${i} present`);
  assert.ok(!out.includes('## project'), 'feedback fills the budget before any project');
  const kept = lines.filter((l) => l.startsWith('- [')).length;
  assert.equal(lines.at(-1), `+${300 - kept} more: _index/demo.md, or memory_search`);
  // Most recent feedback wins within the type.
  assert.ok(out.includes('[feedback-079]'));
  assert.ok(!out.includes('[feedback-000]'));
});

test('missing description falls back to the summary, clipped to 120', () => {
  const long = 'word '.repeat(60).trim();
  const out = renderMemoryIndex('demo', [
    note('a', { description: null, summary: 'short summary' }),
    note('b', { description: null, summary: long }),
    note('c', { description: null, summary: null }),
    note('d', { description: long }),
  ]);
  const line = (n: string) => out.split('\n').find((l) => l.startsWith(`- [${n}]`))!;
  assert.equal(line('a'), '- [a](a.md) — short summary');
  const hook = line('b').slice('- [b](b.md) — '.length);
  assert.equal(hook.length, 120);
  assert.ok(hook.endsWith('…'));
  assert.ok(long.startsWith(hook.slice(0, -1)));
  assert.equal(line('c'), '- [c](c.md)');
  assert.equal(line('d').slice('- [d](d.md) — '.length).length, 120);
});

test('same input renders byte-identical output', () => {
  const notes = Array.from({ length: 150 }, (_, i) => note(`n-${i}`, { type: ['user', 'feedback', 'project', 'reference'][i % 4], recency: i % 7 }));
  const a = renderMemoryIndex('demo', notes);
  const b = renderMemoryIndex('demo', [...notes].reverse());
  assert.equal(a, b);
  assert.equal(renderCatalog('demo', notes), renderCatalog('demo', [...notes].reverse()));
});

test('catalog lists every note with its vault path link and tags', () => {
  const notes = [
    note('db-migrations', { file: 'db-migrations.md', type: 'feedback', tags: ['db', 'migrations'] }),
    note('alpha', { type: null }),
    note('who-am-i', { type: 'user', tags: ['profile'] }),
  ];
  assert.equal(renderCatalog('demo', notes), [
    '# demo',
    '## user',
    '- [[projects/demo/who-am-i|who-am-i]] — what who-am-i answers #profile',
    '## feedback',
    '- [[projects/demo/db-migrations|db-migrations]] — what db-migrations answers #db #migrations',
    '## project',
    '- [[projects/demo/alpha|alpha]] — what alpha answers',
    '',
  ].join('\n'));
  const many = Array.from({ length: 300 }, (_, i) => note(`n-${i}`));
  const catalog = renderCatalog('demo', many);
  for (let i = 0; i < 300; i++) assert.ok(catalog.includes(`[[projects/demo/n-${i}|n-${i}]]`));
});

test('log appends and keeps the last 500 lines', () => {
  const kit = makeKit();
  const vault = kit.paths.vault;
  try {
    const now = new Date(2026, 10, 9, 12);
    appendLog(vault, 'demo', [{ op: 'add', name: 'first' }, { op: 'fix', name: 'second', reason: 'name-mismatch' }], now);
    const path = join(vault, '_log', 'demo.md');
    assert.equal(readFileSync(path, 'utf8'), '2026-11-09 add first\n2026-11-09 fix second name-mismatch\n');

    mkdirSync(join(vault, '_log'), { recursive: true });
    writeFileSync(path, Array.from({ length: 499 }, (_, i) => `2026-11-01 add old-${i}`).join('\n') + '\n');
    appendLog(vault, 'demo', [{ op: 'update', name: 'x' }, { op: 'delete', name: 'y' }, { op: 'migrate', name: 'z', reason: 'from old place' }], now);
    const lines = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n');
    assert.equal(lines.length, 500);
    assert.equal(lines[0], '2026-11-01 add old-2');
    assert.deepEqual(lines.slice(-3), ['2026-11-09 update x', '2026-11-09 delete y', '2026-11-09 migrate z from old place']);
  } finally {
    kit.close();
  }
});
