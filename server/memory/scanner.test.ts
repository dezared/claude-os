import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createScanner } from './scanner.ts';
import { until } from './testkit.ts';

let base: string;
let places: { vault: string; claudeProjects: string };
let snap: string;
const dir = () => join(places.vault, 'projects', 'p');
const note = (name: string, body = `The ${name} fact.`) => `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: project\n  tags: [t]\n---\n${body}\n`;
const put = (name: string, body?: string) => writeFileSync(join(dir(), `${name}.md`), note(name, body));
const titles = (s: ReturnType<typeof createScanner>) => s.current().notes.map((n) => n.file).sort();

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-os-scanner-'));
  places = { vault: join(base, 'vault'), claudeProjects: join(base, 'claude', 'projects') };
  snap = join(base, 'data', 'memory-snapshot.ndjson');
  mkdirSync(dir(), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function started() {
  const s = createScanner(places, snap);
  await s.ready;
  return s;
}

test('scanner: a small vault is read before createScanner returns, and a snapshot is written', async () => {
  put('a');
  put('b');
  const s = createScanner(places, snap);
  assert.equal(s.complete(), true);
  assert.deepEqual(titles(s), ['a.md', 'b.md']);
  await s.ready;
  await s.close();
  const lines = readFileSync(snap, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]).meta.body, undefined); // the body is cut from the content again on load
});

test('scanner: a start keeps unchanged notes from the snapshot and rereads only what moved', async () => {
  for (const n of ['a', 'b', 'c']) put(n);
  const a = join(dir(), 'a.md');
  utimesSync(a, 1_700_000_000, 1_700_000_000);
  await (await started()).close();
  // Same size and mtime on disk, other text in the snapshot: kept as the snapshot has it, so it was not read.
  writeFileSync(snap, readFileSync(snap, 'utf8').replace('The a fact.', 'The A fact.'));
  put('b', 'A longer body for b now.');
  rmSync(join(dir(), 'c.md'));
  put('d');
  const s = await started();
  assert.deepEqual(titles(s), ['a.md', 'b.md', 'd.md']);
  const byFile = new Map(s.current().notes.map((n) => [n.file, n]));
  assert.match(byFile.get('a.md')!.content, /The A fact\./);
  assert.equal(byFile.get('a.md')!.meta.body, 'The A fact.\n');
  assert.match(byFile.get('b.md')!.content, /longer body/);
  await s.close();
});

test('scanner: a broken, foreign or old snapshot is ignored and the vault read instead', async () => {
  put('a');
  for (const text of ['{not json', '{"format":"claude-os-memory-snapshot","version":0}\n', 'x\n{"path":1}\n']) {
    mkdirSync(join(base, 'data'), { recursive: true });
    writeFileSync(snap, text);
    const s = await started();
    assert.deepEqual(titles(s), ['a.md']);
    await s.close();
  }
});

test('scanner: a large vault is not complete until the start pass has checked every file', async () => {
  for (let i = 0; i < 1500; i++) put(`n${i}`);
  const s = createScanner(places, snap);
  assert.equal(s.complete(), false);
  s.mark([join(dir(), 'n1.md')]); // a watcher event during the start is kept for later
  await s.ready;
  assert.equal(s.complete(), true);
  assert.equal(s.current().notes.length, 1500);
  await until(() => existsSync(snap)); // written in slices after the start pass; a close abandons it
  await s.close();
});

test('scanner: a write asks for a stat pass that runs at once after the start', async () => {
  put('a');
  const s = await started();
  put('b');
  s.mark();
  assert.deepEqual(titles(s), ['a.md', 'b.md']);
  const v = s.current().version;
  assert.equal(s.current().version, v);
  await s.close();
});
