// The user's small requests, each one job of the hidden service session. The card on screen reads this list.
// At most one round of questions: the job records them and ends its turn, so nothing idles while they think;
// their answer resumes the same conversation in a new job.
import { randomUUID } from 'node:crypto';
import type { OsSource, ServiceTask } from '../../shared/contract.ts';
import type { Ctx, ServiceJobHooks } from '../context.ts';
import { HttpError } from './session.ts';
import type { Chat } from './manager.ts';
import { MICROTASK_ROUTES, MICROTASK_TOOLS, servicePrompt } from '../tools/microtasks.ts';

const META_KEY = 'service_tasks';
const KEEP = 20;
const ANSWER_LENGTH = 20_000;

interface Row extends ServiceTask {
  prompt: string;
  asked: boolean;
  moreRounds?: number; // rounds of questions allowed after the first: a brainstorm needs them, a small job does not
  tools?: readonly string[]; // extra tools its template grants, kept for the answer and the retry
  sessionId: string | null;
  source?: OsSource;
  sourceDetail?: string;
}

const publicPart = ({ prompt: _p, asked: _a, moreRounds: _m, tools: _t, sessionId: _s, source: _o, sourceDetail: _d, ...task }: Row): ServiceTask => task;

function wrap(task: Row, ctx: Ctx): string {
  const project = task.project && ctx.journal.listProjects(true).find((p) => p.key === task.project);
  return [
    `A task from the user: "${task.title}".`,
    project ? `Project: ${project.name}, key ${project.key}, folder ${project.root}.` : '',
    task.prompt,
  ].filter(Boolean).join('\n\n');
}

type StartBody = { title?: string; prompt?: string; microtask?: string; vars?: Record<string, string>; project?: string | null; modal?: boolean; link?: string; rounds?: number; source?: OsSource; sourceDetail?: string };

// microtask: a service template filled here with vars. Its extra tools come only this way, never with a free prompt.
function taskPrompt(ctx: Ctx, body: StartBody): { prompt?: string; tools?: readonly string[] } {
  if (!body.microtask) return { prompt: body.prompt?.trim() };
  if (MICROTASK_ROUTES[body.microtask] !== 'service') throw new HttpError(400, `Not a service template: ${body.microtask}`, 'notServiceTemplate', { id: body.microtask });
  return { prompt: servicePrompt(ctx, body.microtask, body.vars ?? {}).trim(), tools: MICROTASK_TOOLS[body.microtask] };
}

export class ServiceTasks {
  private ctx: Ctx;
  private chat: Chat;
  private rows: Row[];
  private current: Row | null = null;
  private live = new Map<string, ServiceJobHooks>(); // the job of a task in line or running, so it can be interrupted

  constructor(ctx: Ctx, chat: Chat) {
    this.ctx = ctx;
    this.chat = chat;
    const saved = ctx.db.prepare('SELECT v FROM chat_meta WHERE k = ?').get(META_KEY) as { v: string } | undefined;
    this.rows = saved ? JSON.parse(saved.v) as Row[] : [];
    // Its process died with the server. The card says so and offers the retry: a job does not restart by itself.
    let changed = false;
    for (const r of this.rows) {
      if (r.status !== 'queued' && r.status !== 'running') continue;
      r.status = 'failed';
      r.error = 'The server restarted during the task';
      r.errorKey = 'serverRestartedTask';
      changed = true;
    }
    if (changed) this.save();
  }

  list(): ServiceTask[] {
    return this.rows.map(publicPart);
  }

  start(body: StartBody): ServiceTask {
    const { prompt, tools } = taskPrompt(this.ctx, body);
    if (!prompt) throw new HttpError(400, 'Empty task', 'emptyTask');
    const row: Row = {
      id: randomUUID(),
      title: body.title?.trim() || prompt.slice(0, 80),
      project: body.project ?? null,
      status: 'queued',
      answer: null,
      error: null,
      questions: null,
      ...(body.modal ? { modal: true } : {}),
      ...(body.link ? { link: body.link } : {}),
      ...(body.rounds && body.rounds > 1 ? { moreRounds: body.rounds - 1 } : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.sourceDetail ? { sourceDetail: body.sourceDetail } : {}),
      ...(body.microtask === 'quick-start' ? { continuable: false as const } : {}), // it opened the tab itself
      tools,
      created: Date.now(),
      prompt,
      asked: false,
      sessionId: null,
    };
    this.rows.unshift(row);
    this.rows.splice(KEEP);
    this.run(row, wrap(row, this.ctx));
    return publicPart(row);
  }

  private run(row: Row, prompt: string, resume?: string): void {
    this.save();
    const hooks: ServiceJobHooks = {
      start: () => {
        row.status = 'running';
        this.current = row;
        this.save();
      },
      end: (error, outcome, message) => {
        this.live.delete(row.id);
        if (this.current === row) this.current = null;
        row.sessionId = outcome?.sessionId ?? row.sessionId;
        row.answer = outcome?.text?.slice(0, ANSWER_LENGTH) ?? null;
        row.error = error;
        row.errorKey = message?.key;
        row.errorParams = message?.params;
        // A question recorded in this job waits for the user; everything else is over.
        row.status = error ? 'failed' : row.questions ? 'question' : 'done';
        this.save();
      },
    };
    this.live.set(row.id, hooks);
    this.chat.runServiceJob(prompt, hooks, { task: true, ...(resume ? { resume } : {}), source: row.source, sourceDetail: row.sourceDetail, ...(row.tools ? { tools: row.tools } : {}) });
  }

  /** Called by the running job's ask_owner. False: this task has had its one round. */
  ask(questions: string[]): boolean {
    const row = this.current;
    if (!row) return false;
    if (row.asked) {
      if (!row.moreRounds) return false;
      row.moreRounds -= 1;
    }
    row.asked = true;
    row.questions = questions;
    this.save();
    return true;
  }

  answer(id: string, text: string): ServiceTask {
    const row = this.find(id);
    if (row.status !== 'question' || !row.sessionId) throw new HttpError(409, 'This task is not waiting for an answer', 'taskNotWaiting');
    if (!text.trim()) throw new HttpError(400, 'Empty answer', 'emptyAnswer');
    const next = row.moreRounds ? 'Ask again through ask_owner only if you cannot go on without it; otherwise finish the task.' : 'Ask no more questions, finish the task.';
    const message = `The user's answer:\n${text.trim()}\n\n${next}`;
    row.questions = null;
    row.status = 'queued';
    this.run(row, message, row.sessionId);
    return publicPart(row);
  }

  retry(id: string): ServiceTask {
    const row = this.find(id);
    if (row.status !== 'failed') throw new HttpError(409, 'This task did not fail', 'taskNotFailed');
    Object.assign(row, { status: 'queued', error: null, errorKey: undefined, errorParams: undefined, answer: null, questions: null, asked: false, sessionId: null });
    this.run(row, wrap(row, this.ctx));
    return publicPart(row);
  }

  /** The owner stops it: the job ends, the record goes. What it already did stays done. */
  interrupt(id: string): void {
    const row = this.find(id);
    const hooks = this.live.get(row.id);
    this.rows = this.rows.filter((r) => r !== row);
    if (hooks) this.chat.cancelServiceJob(hooks, { error: 'Interrupted', key: 'interrupted' });
    this.save();
  }

  dismiss(id: string): void {
    const row = this.find(id);
    if (row.status === 'queued' || row.status === 'running') throw new HttpError(409, 'The task is still running', 'taskRunning');
    this.rows = this.rows.filter((r) => r !== row);
    this.save();
  }

  private find(id: string): Row {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new HttpError(404, 'Task not found', 'taskNotFound');
    return row;
  }

  private save(): void {
    this.ctx.db.prepare('INSERT OR REPLACE INTO chat_meta (k, v) VALUES (?, ?)').run(META_KEY, JSON.stringify(this.rows));
    this.ctx.invalidate('service');
  }
}
