// Service tasks shown in a dialog: more than one round of questions, and the owner's interrupt. A fake chat, no process.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import type { ServiceJobHooks } from '../context.ts';
import { addNote, plannerDir, registerPlanner } from '../tools/planner.ts';
import { ServiceTasks } from './serviceTasks.ts';

const base = mkdtempSync(join(tmpdir(), 'claude-os-tasks-'));
after(() => rmSync(base, { recursive: true, force: true }));

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE chat_meta (k TEXT PRIMARY KEY, v TEXT)');
  const jobs: { prompt: string; hooks: ServiceJobHooks; resume?: string }[] = [];
  const cancelled: ServiceJobHooks[] = [];
  const chat = {
    runServiceJob: (prompt: string, hooks: ServiceJobHooks, options: { resume?: string }) => void jobs.push({ prompt, hooks, resume: options.resume }),
    cancelServiceJob: (hooks: ServiceJobHooks, reason: { error: string; key?: string }) => {
      cancelled.push(hooks);
      hooks.end(reason.error, undefined, { key: reason.key });
    },
  };
  const ctx = { db, journal: { listProjects: () => [] }, invalidate: () => {} };
  return { tasks: new ServiceTasks(ctx as never, chat as never), jobs, cancelled, again: () => new ServiceTasks(ctx as never, chat as never) };
}

test('a failure keeps its key for the UI; a restart fails the running task with one; a retry clears it', () => {
  const { tasks, jobs, again } = setup();
  const failed = tasks.start({ title: 'f', prompt: 'x' });
  jobs[0].hooks.start();
  jobs[0].hooks.end('The job took too long and was stopped', { text: null, sessionId: null }, { key: 'jobTooLong' });
  const row = tasks.list().find((t) => t.id === failed.id)!;
  assert.deepEqual([row.status, row.error, row.errorKey], ['failed', 'The job took too long and was stopped', 'jobTooLong']);
  tasks.retry(failed.id);
  assert.deepEqual([tasks.list()[0].error, tasks.list()[0].errorKey], [null, undefined]);
  jobs[1].hooks.start();
  const after = again().list().find((t) => t.id === failed.id)!;
  assert.deepEqual([after.status, after.error, after.errorKey], ['failed', 'The server restarted during the task', 'serverRestartedTask']);
});

test('a task with rounds asks again; a plain one asks once', () => {
  const { tasks, jobs } = setup();
  const plain = tasks.start({ title: 'p', prompt: 'x' });
  jobs[0].hooks.start();
  assert.equal(tasks.ask(['один?']), true);
  assert.equal(tasks.ask(['ещё?']), false, 'one round');
  jobs[0].hooks.end(null, { text: '', sessionId: 's1' });
  assert.equal(tasks.list().find((t) => t.id === plain.id)!.status, 'question');

  const deep = tasks.start({ title: 'd', prompt: 'x', modal: true, rounds: 2, link: 'alpha' });
  assert.deepEqual([deep.modal, deep.link], [true, 'alpha']);
  jobs[1].hooks.start();
  assert.equal(tasks.ask(['первый?']), true);
  jobs[1].hooks.end(null, { text: '', sessionId: 's2' });
  tasks.answer(deep.id, 'ответ');
  assert.equal(jobs[2].resume, 's2');
  assert.match(jobs[2].prompt, /ask_owner/, 'it may ask again');
  jobs[2].hooks.start();
  assert.equal(tasks.ask(['второй?']), true);
  assert.equal(tasks.ask(['третий?']), false, 'rounds run out');
  jobs[2].hooks.end(null, { text: '', sessionId: 's2' });
  tasks.answer(deep.id, 'ответ 2');
  assert.match(jobs[3].prompt, /Ask no more questions/);
  assert.equal('moreRounds' in tasks.list().find((t) => t.id === deep.id)!, false, 'the count stays on the server');
});

test('an interrupt stops a live job and removes the task; one waiting for an answer has no job to stop', () => {
  const { tasks, jobs, cancelled } = setup();
  const live = tasks.start({ title: 'l', prompt: 'x', modal: true });
  jobs[0].hooks.start();
  tasks.interrupt(live.id);
  assert.deepEqual(cancelled, [jobs[0].hooks]);
  assert.equal(tasks.list().length, 0);

  const waiting = tasks.start({ title: 'w', prompt: 'x', modal: true });
  jobs[1].hooks.start();
  tasks.ask(['?']);
  jobs[1].hooks.end(null, { text: '', sessionId: 's' });
  tasks.interrupt(waiting.id);
  assert.equal(cancelled.length, 1);
  assert.equal(tasks.list().length, 0);
  assert.throws(() => tasks.interrupt('нет'));
});

test('a planner note goes to a modal task, with its text and project, and the note stays', async () => {
  const data = join(base, 'data');
  const started: { prompt: string; project: string | null; modal: boolean; rounds: number; link?: string; title: string }[] = [];
  const app = Fastify();
  const ctx = { app, journal: { listProjects: () => [] }, paths: { data, root: join(import.meta.dirname, '../../root') }, audit: () => {}, invalidate: () => {}, chat: { tasks: { start: (b: never) => (started.push(b), { id: 't1' }) } } };
  registerPlanner(ctx as never);
  const note = addNote(plannerDir(ctx as never), '- [ ] сделать вход\n- [ ] сделать выход');
  const res = await app.inject({ method: 'POST', url: `/api/planner/${encodeURIComponent(note.id)}/decompose` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([started[0].modal, started[0].rounds, started[0].project, started[0].title], [true, 3, null, note.title]);
  assert.ok(!('link' in started[0]), 'no project: the whole board');
  assert.match(started[0].prompt, /сделать вход/);
  assert.match(started[0].prompt, /ask_owner/);
  assert.match(started[0].prompt, /add_kanban_card/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/planner/нет/decompose' })).statusCode, 404);
  assert.ok((await app.inject({ url: `/api/planner/${encodeURIComponent(note.id)}` })).json<{ text: string }>().text.includes('сделать выход'));
  await app.close();
});
