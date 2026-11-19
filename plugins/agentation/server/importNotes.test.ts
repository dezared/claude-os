// The one-time import against the real agentation server on a free port with the in-memory store.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { importNotes, type LocalNote } from './importNotes.ts';

let daemon: ChildProcess;
let base: string;
const PAGE = 'http://127.0.0.1:47821/';

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as { port: number };
      s.close(() => resolve(p));
    });
  });
  base = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'daemon.ts'), '--port', String(port)], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, AGENTATION_STORE: 'memory' } });
  for (let i = 0; i < 150 && !(await fetch(`${base}/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
});
after(() => {
  daemon.kill();
});

const note = (id: string, comment: string, extra: Partial<LocalNote> = {}): LocalNote => ({ id, x: 0.5, y: 147, comment, element: 'min flex', elementPath: '.sheet > .flex', timestamp: 1794560197437 + Number(id.slice(-1)), boundingBox: { x: 8, y: 144, width: 287, height: 767 }, fullPath: 'body > div#root', ...extra });
const pending = async () => ((await (await fetch(`${base}/pending`)).json()) as { annotations: { comment: string; sessionId: string; boundingBox?: unknown }[] }).annotations;

it('imports open notes as pending under the page session, keeps their fields, and adds nothing on a second run', async () => {
  const notes = [note('1', 'Tree of projects'), note('2', 'Move this panel'), note('3', 'Already done', { status: 'resolved' }), note('4', 'A placement', { kind: 'placement' })];
  const first = await importNotes(base, PAGE, notes);
  assert.equal(first.added, 2);
  const got = await pending();
  assert.deepEqual(got.map((a) => a.comment).sort(), ['Move this panel', 'Tree of projects']);
  assert.ok(got.every((a) => a.sessionId === first.sessionId));
  assert.deepEqual(got[0].boundingBox, { x: 8, y: 144, width: 287, height: 767 });

  const again = await importNotes(base, PAGE, notes);
  assert.deepEqual(again, { sessionId: first.sessionId, added: 0, skipped: 4 });
  assert.equal((await pending()).length, 2);
});

it('joins the session the toolbar already made for the page, even with a query in its address', async () => {
  const made = (await (await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${PAGE}?popout=tab&id=x` }) })).json()) as { id: string };
  const r = await importNotes(base, PAGE, [note('5', 'One more')]);
  assert.deepEqual(r, { sessionId: made.id, added: 1, skipped: 0 });
});
