import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { query, type CanUseTool, type Options, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type Settings, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DENY_TEXTS, type ChatEvent, type MessageKey, type OsSource, type RespondRequest, type SendRequest, type SessionStatus, type Tab, type TabProgress, type TaskInfo, type TaskState, type TerminalRun } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { withDevIsolation } from './devIsolation.ts';
import { HttpError } from './httpError.ts';
import { permissionDiff } from './diff.ts';
import { promptKindOf, sessionProfileBlock } from './profile.ts';
import { questionDenial } from './questionCap.ts';
import { buildMessage, withText, type OutgoingMessage } from './files.ts';
import { Inbox } from './inbox.ts';
import { PATH_RULE, PROGRESS_RULE, UI_TOOL_RULE } from './rootMcp.ts';
import { kanbanDir, recordCardSession } from '../tools/kanban.ts';
import { DOCUMENT_RULE, documentBrief } from '../tools/documents.ts';
import { plannerDir } from '../tools/planner.ts';
import { noteGuardHooks } from '../memory/guard.ts';
import { runInPty } from './terminal.ts';
import { assistantBlocks, BACKGROUND_COMMANDS, CLEAR_COMMANDS, REMOTE_CONTROL_COMMANDS, slashCommands, tokenCounts, toolResultText } from './translate.ts';

const BUFFER_SIZE = 5000;
const INTERRUPT_GRACE_MS = 10_000;
const PERMISSION_MODES = new Set<string>(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] satisfies PermissionMode[]);
const TASK_ENDED: Record<string, TaskInfo['status']> = { completed: 'completed', failed: 'failed', killed: 'stopped' };

// Folded into the running turn at its next tool boundary; 'now' would abort whatever tool is running.
const INTO_RUNNING_TURN = 'next' as const;

// In the SDK's runtime since it spoke the CLI's remote_control request, missing from its published types.
type RemoteControlQuery = Query & { enableRemoteControl(enabled: boolean, name?: string): Promise<{ session_url?: string; connect_url?: string }> };

export interface TabRow {
  id: string;
  kind: Tab['kind'];
  project: string | null;
  cwd: string;
  sessionId: string | null;
  title: string;
  order: number;
  model: string | null;
  effort: string | null;
  worktree: boolean;
  turnOpen: boolean; // survives a restart: an open turn becomes {e:'interrupted'}
  interruptedAt: number | null; // a restart cut its turn and the user has not decided yet: /api/recovery lists it
  permissionMode: string | null;
  document?: string | null; // kind 'document': whose tab this is
  source?: OsSource | null; // Claude OS opened it for itself: see NewTabRequest.source
  sourceDetail?: string | null;
}

// What report_progress stored. `said` is Claude's word; `crashed` is what really happened to the last turn.
export interface StoredProgress {
  percent: number;
  step: string | null;
  said: TaskState | null;
  crashed: boolean;
  at: number;
}

export type ProgressReport = { percent: number; step?: string; status?: TaskState; restart?: boolean };

const STEP_LENGTH = 60;

export { HttpError };

export interface SessionHost {
  ctx: Ctx;
  idleMs: number;
  save(row: TabRow): void;
  publish(tabId: string, event: ChatEvent): void;
  neighbours(session: TabSession): TabSession[];
  assertNotLiveElsewhere(sessionId: string): void;
  readStatus(row: TabRow): SessionStatus; // read-only tabs mirror the journal
  extraOptions(row: TabRow): Partial<Options>; // MCP: the whole server in the root tab, planner items in the others
  noteRules(): string; // appended to every session's system prompt
  rememberTerminalCommands(names: string[]): void;
  saveQueue(tabId: string, items: { id: string; message: OutgoingMessage }[]): void;
  saveProgress(tabId: string, progress: StoredProgress | null): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<ChatEvent, 'seq' | 'at'>;

interface Pending {
  kind: RespondRequest['kind'];
  tool: string;
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
}

// What a tab adds to the system prompt, in this order; promptBudget.test.ts holds a work tab's to 2 KB.
export const sessionAppend = (parts: { profile: string; note: string | null; noteRules: string; document: string | null }): string => [parts.profile, parts.note, parts.noteRules, UI_TOOL_RULE, PATH_RULE, PROGRESS_RULE, DOCUMENT_RULE, parts.document].filter(Boolean).join('\n\n');

export class TabSession {
  row: TabRow;
  buffer: ChatEvent[] = [];
  turn = false;
  private host: SessionHost;
  private ctx: Ctx;
  // Epoch ms as the base keeps seq increasing across restarts and above the transcript's 1..N.
  private seq = Date.now();
  private q: Query | null = null;
  private input: Inbox | null = null;
  private queue: { id: string; message: OutgoingMessage }[] = [];
  held: { id: string; message: OutgoingMessage }[] = []; // queued when the server went down: goes out only when the user says so
  progress: StoredProgress | null = null;
  private reportedThisTurn = false;
  private questionsAsked = 0; // AskUserQuestion calls allowed since the last user message
  private tasks = new Map<string, TaskInfo>();
  private bypassAllowed = false; // the running process was started with allowDangerouslySkipPermissions
  private requestedMode: string | null = null; // what the running process was asked to start in, until its first init
  private pending = new Map<string, Pending>();
  private streamingId: string | null = null;
  private interrupting = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private backgroundTasks = 0;
  private lastStatus: SessionStatus = 'idle';
  private lastInit = '';
  private stderrTail = '';
  private clearing = false; // the CLI is answering a /clear: nothing it says belongs to the new conversation
  private remoteControl = false;
  private stopBackground: (() => void) | null = null;

  constructor(row: TabRow, host: SessionHost) {
    this.row = row;
    this.host = host;
    this.ctx = host.ctx;
  }

  // ---------- Reading state ----------

  status(): SessionStatus {
    if (this.row.kind === 'readonly') return this.host.readStatus(this.row);
    if (this.pending.size > 0) return 'waiting_permission';
    return this.turn ? 'working' : 'idle';
  }

  toTab(): Tab {
    const { id, kind, project, cwd, sessionId, title, order, model, effort, worktree, document } = this.row;
    return { id, kind, ...(document ? { document } : {}), project, cwd, sessionId, title, order, model, effort, worktree, status: this.status(), attention: this.pending.size > 0, queued: this.queue.length, permissionMode: this.row.permissionMode, ...(this.progress ? { progress: this.progressView(this.progress) } : {}) };
  }

  private progressView(p: StoredProgress): TabProgress {
    return { percent: p.percent, step: p.step, at: p.at, state: this.taskState(p) };
  }

  // The tab's real state first, Claude's word only for what the tab cannot know. A turn that ended without "done" waits for the user: nothing runs until they answer.
  private taskState({ percent, said, crashed }: StoredProgress): TaskState {
    if (this.pending.size > 0) return 'waiting';
    if (this.working()) return 'working';
    if (crashed || this.row.interruptedAt) return 'failed';
    if (said === 'failed' || said === 'waiting') return said;
    return said === 'done' || percent === 100 ? 'done' : 'waiting';
  }

  report({ percent, step, status, restart }: ProgressReport): void {
    const was = this.progress;
    // Going back takes a reason: the tool's `restart`, or a new turn after finished work.
    const finished = was?.said === 'done' || was?.said === 'failed' || was?.percent === 100;
    const free = restart || (finished && !this.reportedThisTurn);
    const asked = Math.round(Math.min(100, Math.max(0, percent)));
    const next = status === 'done' ? 100 : was && !free ? Math.max(asked, was.percent) : asked;
    this.reportedThisTurn = true;
    this.setProgress({ percent: next, step: step?.trim().slice(0, STEP_LENGTH) || null, said: status === 'working' ? null : status ?? null, crashed: false, at: Date.now() });
  }

  setProgress(progress: StoredProgress | null): void {
    this.progress = progress;
    this.host.saveProgress(this.row.id, progress);
    this.ctx.invalidate('tabs');
  }

  private noteCrash(): void {
    if (this.progress) this.setProgress({ ...this.progress, crashed: true });
  }

  uploadDir(): string {
    return join(this.ctx.paths.data, 'uploads', this.row.id);
  }

  hasProcess(): boolean {
    return this.q !== null;
  }

  // ---------- Commands ----------

  send(req: SendRequest): void {
    if (this.row.kind === 'readonly') {
      throw new HttpError(409, 'Read-only tab: a session started in a terminal cannot be attached. End it there and press “Continue here”.', 'readonlySend');
    }
    const local = !req.attachments?.length && /^\/([\w-]+)$/.exec(req.text?.trim() ?? '')?.[1];
    if (local && this.runLocal(local)) return;
    if (!this.q && this.row.sessionId) this.host.assertNotLiveElsewhere(this.row.sessionId);
    const message = buildMessage(req, this.uploadDir());
    if (message.blocks.length === 0 || (typeof message.content === 'string' && !message.content.trim())) {
      throw new HttpError(400, 'Empty message', 'emptyMessage');
    }
    this.dispatch(message);
  }

  private dispatch(message: OutgoingMessage): void {
    if (this.turn) {
      const id = randomUUID();
      this.queue.push({ id, message });
      this.saveQueue();
      this.emit({ e: 'user', blocks: message.blocks, queued: true, queueId: id });
      this.ctx.invalidate('tabs');
      return;
    }
    this.startTurn(message);
  }

  private saveQueue(): void {
    this.host.saveQueue(this.row.id, [...this.held, ...this.queue]);
  }

  private heldIndex(id: string): number {
    const i = this.held.findIndex((q) => q.id === id);
    if (i < 0) throw new HttpError(404, 'This message is gone', 'messageGone');
    return i;
  }

  sendHeld(id: string): void {
    const i = this.heldIndex(id);
    if (!this.q && this.row.sessionId) this.host.assertNotLiveElsewhere(this.row.sessionId);
    const [item] = this.held.splice(i, 1);
    this.saveQueue();
    this.dispatch(item.message);
    this.ctx.invalidate('tabs');
  }

  removeHeld(id: string): void {
    this.held.splice(this.heldIndex(id), 1);
    this.saveQueue();
    this.ctx.invalidate('tabs');
  }

  dismissInterrupted(): void {
    this.row.interruptedAt = null;
    this.host.save(this.row);
    this.ctx.invalidate('tabs');
  }

  /** Mid-work: a restart ordered with "go on" sends it a message when the server is back. */
  working(): boolean {
    return this.turn || this.backgroundTasks > 0;
  }

  /** The whole app is going down on purpose: what was in progress waits for a decision at the next start. */
  holdForStop(): void {
    if (this.turn) this.row.interruptedAt = Date.now();
    this.held.push(...this.queue.splice(0));
    this.saveQueue();
  }

  // Commands the stream-json mode has no screen for: Claude OS answers them itself. None of them starts a model turn.
  private runLocal(name: string): boolean {
    if (CLEAR_COMMANDS.has(name)) this.clear();
    else if (REMOTE_CONTROL_COMMANDS.has(name)) void this.toggleRemoteControl();
    else if (BACKGROUND_COMMANDS.has(name)) this.runInBackground(name);
    else return false;
    return true;
  }

  // The process stays: it is told to drop the conversation, the way the terminal does it.
  private clear(): void {
    if (this.turn) throw new HttpError(409, 'Clearing works between turns: wait for the turn to end or interrupt it.', 'clearBetweenTurns');
    if (this.q && this.input) {
      this.clearing = true;
      this.input.push({ type: 'user', message: { role: 'user', content: '/clear' } as SDKUserMessage['message'], parent_tool_use_id: null });
    }
    this.forgetConversation();
  }

  /** The panel's reset: the old process stops, the next message starts a new session. The journal stays on disk. */
  reset(): void {
    if (this.row.kind === 'readonly') throw new HttpError(409, 'Read-only tab', 'readonlyTab');
    this.halt();
    this.forgetConversation();
  }

  // The next init names the new session. Until then there is nothing to resume: a journal may not exist yet.
  private forgetConversation(): void {
    this.queue = [];
    this.saveQueue();
    if (this.progress) this.setProgress(null); // a new conversation has reported nothing
    this.buffer = [];
    this.lastInit = '';
    this.row.sessionId = null;
    this.host.save(this.row);
    this.emit({ e: 'cleared' });
    this.ctx.invalidate('tabs', 'sessions');
  }

  private runInBackground(name: string): void {
    if (this.stopBackground) throw new HttpError(409, 'The previous command is still running', 'commandRunning');
    const runId = randomUUID();
    const command = `/${name}`;
    const show = (screen: string, done: boolean, error: string | null, runs: TerminalRun[] = [], message: MessageKey = {}) => {
      this.buffer = this.buffer.filter((e) => !(e.e === 'terminal' && e.runId === runId));
      this.emit({ e: 'terminal', runId, command, screen, done, error, ...(runs.length ? { runs } : {}), ...message });
      if (done) {
        this.stopBackground = null;
        this.ctx.setBusy('pty:' + this.row.id, false);
      }
    };
    this.ctx.setBusy('pty:' + this.row.id, true);
    this.stopBackground = runInPty(this.ctx, this.row.cwd, command, show);
    show('', false, null);
  }

  // Works over the stream-json protocol, so the same process keeps answering here and on the other side.
  private async toggleRemoteControl(): Promise<void> {
    const on = !this.remoteControl;
    const say = (text: string, key: string, params?: Record<string, string | number>) => this.emit({ e: 'assistant', messageId: randomUUID(), blocks: [{ type: 'text', text }], model: null, key, params });
    try {
      if (!this.q) {
        if (!on) return;
        if (this.row.sessionId) this.host.assertNotLiveElsewhere(this.row.sessionId);
        this.spawn();
      }
      const answer = await (this.q as RemoteControlQuery).enableRemoteControl(on, this.row.title);
      this.remoteControl = on;
      const url = answer?.session_url ?? answer?.connect_url;
      if (!on) say('Remote Control is off.', 'rcOff');
      else if (url) say(`Remote Control is on: ${url}. While it is on, this session's process does not stop. To turn it off: /rc`, 'rcOnUrl', { url });
      else say('Remote Control is on. While it is on, this session\'s process does not stop. To turn it off: /rc', 'rcOn');
      if (!on) this.armIdle();
    } catch (err) {
      const error = (err as Error).message;
      this.emit({ e: 'error', text: `Remote Control was not turned ${on ? 'on' : 'off'}: ${error}`, key: on ? 'rcOnFailed' : 'rcOffFailed', params: { error } });
      this.armIdle();
    }
  }

  private queuedIndex(id: string): number {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) throw new HttpError(404, 'This message is already with Claude or out of the queue', 'queuedGone');
    return i;
  }

  private queueChanged(): void {
    this.saveQueue();
    this.emit({ e: 'queue', items: this.queue.map((q) => ({ id: q.id, blocks: q.message.blocks })) });
    this.ctx.invalidate('tabs');
  }

  editQueued(id: string, text: string): void {
    const item = this.queue[this.queuedIndex(id)];
    const message = withText(item.message, typeof text === 'string' ? text : '');
    if (message.blocks.length === 0 || (typeof message.content === 'string' && !message.content.trim())) throw new HttpError(400, 'Empty message', 'emptyMessage');
    item.message = message;
    this.queueChanged();
  }

  removeQueued(id: string): void {
    this.queue.splice(this.queuedIndex(id), 1);
    this.queueChanged();
  }

  sendQueuedNow(id: string): void {
    const [item] = this.queue.splice(this.queuedIndex(id), 1);
    this.deliver(item);
    this.queueChanged();
  }

  // Into the running turn: the CLI folds it in at the next tool boundary, or takes it right after the turn if none comes.
  private deliver(item: { id: string; message: OutgoingMessage }): void {
    this.emit({ e: 'user', blocks: item.message.blocks, queued: false, queueId: item.id });
    this.questionsAsked = 0;
    this.input!.push({ type: 'user', message: { role: 'user', content: item.message.content } as SDKUserMessage['message'], parent_tool_use_id: null, priority: INTO_RUNNING_TURN });
  }

  // A tool just finished, so Claude is about to go on: the moment the terminal hands over what was typed meanwhile.
  private deliverQueueAtBoundary(): void {
    if (this.queue.length === 0 || this.interrupting || !this.input) return;
    for (const item of this.queue.splice(0)) this.deliver(item);
    this.queueChanged();
  }

  async interrupt(): Promise<void> {
    if (!this.turn) return;
    this.interrupting = true;
    this.cancelQueue('interrupted');
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: DENY_TEXTS.denyInterrupted, interrupt: true }, 'interrupted');
    const q = this.q;
    if (!q) return;
    this.interruptTimer ??= setTimeout(() => q.close(), INTERRUPT_GRACE_MS);
    try {
      await q.interrupt();
    } catch (err) {
      this.ctx.app.log.warn(err);
      q.close(); // nothing left to talk to: the pump ends the turn
    }
  }

  /** The tool call a permission card waits on; the project kit approves a plan only while its card is open. */
  pendingPermission(requestId: string): { tool: string; input: Record<string, unknown> } | null {
    const entry = this.pending.get(requestId);
    return entry?.kind === 'permission' ? { tool: entry.tool, input: entry.input } : null;
  }

  respond(requestId: string, body: RespondRequest): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new HttpError(404, 'The request is already closed or not found', 'requestGone');
    if (body?.kind !== entry.kind) throw new HttpError(400, `Expected an answer of kind ${entry.kind}`, 'wrongAnswerKind', { kind: entry.kind });
    if (body.kind === 'permission') {
      if (body.allow) this.settle(requestId, { behavior: 'allow', updatedInput: entry.input }, 'allow');
      else this.settle(requestId, { behavior: 'deny', message: body.message || DENY_TEXTS.denyRefused }, 'deny');
    } else if (body.kind === 'question') {
      if (typeof body.answers !== 'object' || body.answers === null) throw new HttpError(400, 'answers is required', 'answersRequired');
      this.settle(requestId, { behavior: 'allow', updatedInput: { ...entry.input, answers: body.answers } }, 'answered');
    } else if (body.approve) {
      this.settle(requestId, { behavior: 'allow', updatedInput: entry.input }, 'approved');
    } else {
      this.settle(requestId, { behavior: 'deny', message: body.message || DENY_TEXTS.denyPlan }, 'rejected');
    }
  }

  // Applied to the live process right away, and to every later start through the options.
  async applyModel(model: string | null): Promise<void> {
    this.row.model = model;
    await this.q?.setModel(model ?? undefined).catch((e: Error) => this.emit({ e: 'warning', text: `Model not switched: ${e.message}`, key: 'modelNotSwitched', params: { error: e.message } }));
  }

  async applyEffort(effort: string | null): Promise<void> {
    this.row.effort = effort;
    const effortLevel = effort as NonNullable<Options['effort']> | null;
    await this.q?.applyFlagSettings({ effortLevel }).catch((e: Error) => this.emit({ e: 'warning', text: `Effort not switched: ${e.message}`, key: 'effortNotSwitched', params: { error: e.message } }));
  }

  // Refused changes throw: the switcher keeps showing the mode Claude really is in.
  async applyPermissionMode(mode: string): Promise<void> {
    if (this.row.kind === 'readonly') throw new HttpError(409, 'Read-only tab', 'readonlyTab');
    if (!PERMISSION_MODES.has(mode)) throw new HttpError(400, `Unknown mode: ${mode}`, 'unknownMode', { mode });
    if (this.q && mode === 'bypassPermissions' && !this.bypassAllowed) {
      // The CLI takes this mode only from a process started with the flag, and the flag alone is refused in some setups (root).
      if (this.turn || this.pending.size > 0 || this.backgroundTasks > 0) throw new HttpError(409, 'The mode without checks turns on between turns: Claude restarts for it. Wait for the turn to end.', 'bypassBetweenTurns');
      this.stop();
    }
    if (this.q) {
      try {
        await this.q.setPermissionMode(mode as PermissionMode);
      } catch (err) {
        throw new HttpError(409, `Mode not switched: ${(err as Error).message}`, 'modeNotSwitched', { error: (err as Error).message });
      }
    }
    this.noteMode(mode);
  }

  private noteMode(mode: string): void {
    if (mode === this.row.permissionMode) return;
    this.row.permissionMode = mode;
    this.host.save(this.row);
    this.emit({ e: 'mode', mode });
    this.ctx.invalidate('tabs');
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: DENY_TEXTS.denyTabClosed, interrupt: true }, 'closed');
    this.queue = [];
    this.saveQueue();
    this.stop();
    this.stopBackground?.();
    this.turn = false;
    this.ctx.setBusy('tab:' + this.row.id, false);
  }

  /** Stop the running process, keep the tab: the conversation can go on later from the journal. */
  halt(): boolean {
    if (!this.q) return false;
    this.dispose();
    this.setTurn(false);
    this.syncStatus();
    return true;
  }

  markInterruptedByRestart(): void {
    this.emit({ e: 'interrupted' });
    this.row.turnOpen = false;
    this.row.interruptedAt ??= Date.now();
    this.host.save(this.row);
  }

  // ---------- Turn lifecycle ----------

  private startTurn(message: OutgoingMessage, queueId?: string): void {
    this.clearing = false;
    this.row.interruptedAt = null;
    this.reportedThisTurn = false;
    if (this.progress?.crashed) this.setProgress({ ...this.progress, crashed: false });
    this.emit(queueId ? { e: 'user', blocks: message.blocks, queued: false, queueId } : { e: 'user', blocks: message.blocks });
    const writers = this.host.neighbours(this).filter((s) => s.turn);
    if (writers.length > 0) {
      const names = writers.map((s) => `«${s.row.title}»`).join(', ');
      this.emit({ e: 'warning', text: `A turn is running in the same folder in the tab ${names}: the edits may overlap. For parallel work open a tab with its own worktree.`, key: 'sameFolderTurn', params: { names } });
    }
    this.setTurn(true);
    try {
      if (!this.q) this.spawn();
      this.questionsAsked = 0;
      this.input!.push({ type: 'user', message: { role: 'user', content: message.content } as SDKUserMessage['message'], parent_tool_use_id: null });
    } catch (err) {
      this.emit({ e: 'error', text: `Could not start Claude: ${(err as Error).message}`, key: 'claudeStartFailed', params: { error: (err as Error).message } });
      this.noteCrash();
      this.setTurn(false);
    }
  }

  private finishTurn(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.interrupting = false;
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: DENY_TEXTS.denyTurnEnded }, 'cancelled');
    const next = this.queue.shift();
    if (next) {
      this.saveQueue();
      this.startTurn(next.message, next.id);
      return;
    }
    this.setTurn(false);
    this.armIdle();
    this.ctx.bus.emit('turn-finished', this.row.id);
  }

  private setTurn(on: boolean): void {
    this.turn = on;
    if (on && this.idleTimer) clearTimeout(this.idleTimer);
    if (this.row.turnOpen !== on) {
      this.row.turnOpen = on;
      this.host.save(this.row);
    }
    this.syncStatus();
  }

  private syncStatus(): void {
    const status = this.status();
    this.ctx.setBusy('tab:' + this.row.id, this.turn || this.pending.size > 0 || this.backgroundTasks > 0);
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit({ e: 'status', status });
    }
    this.ctx.invalidate('tabs', 'sessions');
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.q) return;
    this.idleTimer = setTimeout(() => {
      if (this.turn || this.pending.size > 0) return;
      if (this.backgroundTasks > 0 || this.remoteControl) this.armIdle(); // the process owns those tasks and the remote link
      else this.stop();
    }, this.host.idleMs);
    this.idleTimer.unref();
  }

  private stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    const q = this.q;
    this.q = null; // the pump sees it is no longer current and does nothing
    this.input?.close();
    this.input = null;
    q?.close();
    this.endTasks();
    this.remoteControlEnded();
  }

  private remoteControlEnded(): void {
    if (!this.remoteControl) return;
    this.remoteControl = false;
    this.emit({ e: 'warning', text: 'The session process stopped, Remote Control is off.', key: 'rcStopped' });
  }

  // The tasks die with their process and no notification comes for them.
  private endTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') this.emit({ e: 'task', task: { ...task, status: 'stopped' } });
    }
    this.tasks.clear();
  }

  private cancelQueue(reason: 'interrupted' | 'exited'): void {
    if (this.queue.length === 0) return;
    const texts = this.queue.map((q) => q.message.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')).join('\n');
    this.queue = [];
    this.saveQueue();
    const why = reason === 'interrupted' ? 'Turn interrupted' : 'The Claude process exited';
    this.emit({ e: 'warning', text: `${why}. Queued messages were not sent:\n${texts}`, key: reason === 'interrupted' ? 'queueDroppedInterrupted' : 'queueDroppedExited', params: { texts } });
    this.ctx.invalidate('tabs');
  }

  // ---------- The process ----------

  private spawn(): void {
    const { row, ctx } = this;
    const resume = row.sessionId ?? undefined;
    const vaultDir = this.noteDir();
    const append = sessionAppend({ profile: sessionProfileBlock(ctx, promptKindOf(ctx.paths, row)), note: !resume && row.project ? ctx.memory.stateNote(row.project) : null, noteRules: this.host.noteRules(), document: row.document ? documentBrief(row.document) : null });
    const uploads = join(ctx.paths.data, 'uploads');
    mkdirSync(uploads, { recursive: true });
    // A note dragged into a chat is read by path, from any project, without a permission prompt. Writing stays denied below.
    const planner = plannerDir(ctx);
    mkdirSync(planner, { recursive: true });
    // A task's card too: @OS-21 and the board's `path` are read from any project.
    const kanban = kanbanDir(ctx);
    mkdirSync(kanban, { recursive: true });
    // `//` is the absolute-path anchor of permission rules; one slash would mean "relative to the settings source".
    // Write(path) rules never match: Edit(path) covers every file-writing tool.
    const denyData = `Edit(/${realpathSync(ctx.paths.data)}/**)`;

    const options: Options = {
      pathToClaudeCodeExecutable: ctx.paths.claudeBin,
      cwd: row.cwd,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
      disallowedTools: [denyData],
      additionalDirectories: [uploads, planner, kanban],
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      hooks: noteGuardHooks(ctx.memory, row.id),
      stderr: (data) => { this.stderrTail = (this.stderrTail + data).slice(-2000); },
      ...(resume ? { resume } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort as NonNullable<Options['effort']> } : {}),
      ...(row.permissionMode ? { permissionMode: row.permissionMode as PermissionMode } : {}),
      ...(row.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(vaultDir ? { settings: { autoMemoryDirectory: vaultDir } } : {}),
      // The SDK has no worktree option. On resume the session already lives in the worktree (cwd).
      ...(row.worktree && !resume ? { extraArgs: { worktree: `os-${row.id}` } } : {}),
      ...this.host.extraOptions(row),
    };
    // A product session must not inherit the dev kit of the repo it lives in. Last, so the service settings are merged in.
    const settings = withDevIsolation(ctx.paths, row.cwd, options.settings as Settings | undefined);
    if (settings) options.settings = settings;

    const input = new Inbox();
    const q = query({ prompt: input, options });
    this.q = q;
    this.input = input;
    this.stderrTail = '';
    this.bypassAllowed = row.permissionMode === 'bypassPermissions';
    this.requestedMode = row.permissionMode;
    void this.pump(q);
  }

  // Notes of every Claude OS session go to the vault, without touching the project's settings. The root tab's notes
  // belong to Claude OS itself. If the old notes cannot be copied, the session keeps the old place: it must not lose them.
  private noteDir(): string | null {
    const key = this.row.kind === 'root' ? this.ctx.journal.projectForCwd(this.ctx.paths.repo) : this.row.project;
    if (!key) return null;
    try {
      return this.ctx.memory.prepareSessionDir(key).dir;
    } catch (err) {
      this.emit({ e: 'warning', text: `Notes were not copied to the vault, new ones stay in the old place: ${(err as Error).message}`, key: 'notesNotMoved', params: { error: (err as Error).message } });
      return null;
    }
  }

  /** The CLI's current list; null when no process is running. */
  async commands(): Promise<{ name: string; description: string; argumentHint: string; builtin?: boolean }[] | null> {
    return this.q ? this.q.supportedCommands() : null;
  }

  private async pump(q: Query): Promise<void> {
    let failure: Error | null = null;
    try {
      for await (const m of q) if (this.q === q) this.onMessage(m);
    } catch (err) {
      failure = err as Error;
    }
    if (this.q !== q) return;
    this.q = null;
    this.input = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.backgroundTasks = 0;
    this.endTasks();
    this.remoteControlEnded();
    if (!this.turn) {
      this.syncStatus();
      return;
    }
    const interrupted = this.interrupting;
    const text = failure?.message ?? 'The Claude process exited mid-turn';
    const stderr = this.stderrTail.trim();
    const error = interrupted ? null : [text, stderr].filter(Boolean).join('\n');
    // Only the server's own words have a key; an error of the SDK stays as it came.
    const message = failure ? {} : { key: 'claudeExitedMidTurn', params: { stderr: stderr && `\n${stderr}` } };
    if (error) {
      this.emit({ e: 'error', text: error, ...message });
      this.cancelQueue('exited');
      this.noteCrash();
    }
    this.emit({ e: 'result', usage: tokenCounts(null), costUsd: null, interrupted, error, ...(error ? message : {}) });
    this.finishTurn();
  }

  private canUseTool: CanUseTool = (tool, input, opts) => new Promise<PermissionResult>((resolve) => {
    const requestId = opts.requestId ?? randomUUID();
    const kind: Pending['kind'] = tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
    const denial = kind === 'question' ? this.questionDenied() : null;
    if (denial) return resolve({ behavior: 'deny', message: denial });
    this.pending.set(requestId, { kind, tool, input, resolve });
    opts.signal.addEventListener('abort', () => this.settle(requestId, { behavior: 'deny', message: DENY_TEXTS.denyCancelled }, 'cancelled'), { once: true });
    if (kind === 'question') this.emit({ e: 'question', requestId, questions: input.questions });
    else if (kind === 'plan') this.emit({ e: 'plan', requestId, plan: planText(input) });
    else this.emit({ e: 'permission', requestId, tool, input, diff: permissionDiff(tool, input), title: opts.title ?? null });
    this.syncStatus();
  });

  // Over the question level's cap the question is refused before the user sees it; an allowed one counts.
  private questionDenied(): string | null {
    const denial = questionDenial(this.ctx.settings?.profile()?.questionLevel ?? null, this.questionsAsked);
    if (!denial) this.questionsAsked++;
    return denial;
  }

  private settle(requestId: string, result: PermissionResult, decision: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve(result);
    this.emit({ e: 'resolved', requestId, decision });
    this.syncStatus();
  }

  // ---------- SDK messages to chat events ----------

  private onMessage(m: SDKMessage): void {
    if (this.clearing) {
      if (m.type === 'result') this.clearing = false;
      return;
    }
    switch (m.type) {
      case 'system': return this.onSystem(m);
      case 'conversation_reset':
        this.adoptSession(m.new_conversation_id);
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        this.ensureTurn();
        const ev = m.event as { type: string; message?: { id: string }; delta?: { type: string; text?: string } };
        if (ev.type === 'message_start') this.streamingId = ev.message?.id ?? null;
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && this.streamingId) {
          this.emit({ e: 'delta', messageId: this.streamingId, text: ev.delta.text ?? '' });
        }
        return;
      }
      case 'assistant': {
        if (!m.parent_tool_use_id) this.ensureTurn(); // a background subagent keeps talking after its turn has ended
        // The CLI delivers one API message block by block under a single id. The same id means "append blocks",
        // as in the journal parser. Deltas of finished blocks are dropped so they don't eat the ring.
        const messageId = m.message.id;
        this.buffer = this.buffer.filter((e) => !(e.e === 'delta' && e.messageId === messageId));
        // A subagent's words belong to its own view, the conversation only follows its calls.
        const all = assistantBlocks(m.message.content, m.parent_tool_use_id);
        const blocks = m.parent_tool_use_id ? all.filter((b) => b.type === 'tool_use') : all;
        if (blocks.length > 0) this.emit({ e: 'assistant', messageId, blocks, model: m.message.model ?? null });
        return;
      }
      case 'user': {
        if (!Array.isArray(m.message.content)) return;
        for (const b of m.message.content) {
          if (b.type === 'tool_result') this.emit({ e: 'tool_result', toolUseId: b.tool_use_id, text: toolResultText(b.content), isError: b.is_error === true });
        }
        if (!m.parent_tool_use_id && m.message.content.some((b) => b.type === 'tool_result')) this.deliverQueueAtBoundary();
        return;
      }
      case 'result': {
        const interrupted = this.interrupting || m.terminal_reason === 'aborted_streaming' || m.terminal_reason === 'aborted_tools';
        const failed = m.subtype === 'success' ? (m.is_error ? m.result : null) : m.errors.join('\n') || m.subtype;
        this.streamingId = null;
        this.emit({ e: 'result', usage: tokenCounts(m.usage as Record<string, unknown>), costUsd: m.total_cost_usd ?? null, interrupted, error: interrupted ? null : failed });
        if (!interrupted && failed) this.noteCrash();
        this.finishTurn();
        return;
      }
      case 'rate_limit_event':
        this.ctx.bus.emit('rate-limit', m.session_id, m);
        return;
    }
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init': {
        this.adoptSession(m.session_id);
        if (m.permissionMode) {
          if (this.requestedMode && this.requestedMode !== m.permissionMode) {
            this.emit({ e: 'warning', text: `Claude Code did not take the mode ${this.requestedMode} and runs in the mode ${m.permissionMode}`, key: 'modeRejected', params: { requested: this.requestedMode, actual: m.permissionMode } });
          }
          this.requestedMode = null;
          this.noteMode(m.permissionMode);
        }
        if (this.row.worktree && m.cwd && m.cwd !== this.row.cwd) {
          this.row.cwd = m.cwd;
          this.host.save(this.row);
        }
        if (m.terminal_slash_commands?.length) this.host.rememberTerminalCommands(m.terminal_slash_commands);
        const body = { sessionId: m.session_id, model: m.model ?? null, slashCommands: slashCommands(m.slash_commands ?? [], m.terminal_slash_commands), permissionMode: m.permissionMode ?? null };
        const key = JSON.stringify(body); // the CLI repeats init on every turn
        if (key !== this.lastInit) {
          this.lastInit = key;
          this.emit({ e: 'init', ...body });
        }
        return;
      }
      case 'local_command_output':
        this.emit({ e: 'assistant', messageId: m.uuid, blocks: [{ type: 'text', text: m.content }], model: null });
        return;
      case 'compact_boundary':
        this.emit({ e: 'warning', text: 'Context compacted', key: 'compacted' });
        return;
      case 'permission_denied':
        this.emit({ e: 'warning', text: `${m.tool_name}: denied automatically. ${m.decision_reason ?? m.message}`, key: 'autoDenied', params: { tool: m.tool_name, reason: m.decision_reason ?? m.message } });
        return;
      case 'background_tasks_changed':
        this.backgroundTasks = m.tasks.filter((t) => !t.ambient).length;
        this.syncStatus();
        return;
      case 'status':
        if (m.permissionMode) this.noteMode(m.permissionMode);
        return;
      case 'task_started':
        if (m.skip_transcript) return;
        this.putTask({ id: m.task_id, toolUseId: m.tool_use_id ?? null, type: m.task_type ?? null, description: m.description, agentType: m.subagent_type ?? null, status: 'running', tokens: null, toolUses: null, lastTool: null });
        return;
      case 'task_progress': {
        const task = this.tasks.get(m.task_id);
        if (task) this.putTask({ ...task, description: m.description || task.description, tokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, lastTool: m.last_tool_name ?? task.lastTool });
        return;
      }
      case 'task_updated': {
        const task = this.tasks.get(m.task_id);
        const status = m.patch.status && TASK_ENDED[m.patch.status];
        if (task && status) this.putTask({ ...task, status });
        return;
      }
      case 'task_notification': {
        const task = this.tasks.get(m.task_id);
        if (task) this.putTask({ ...task, status: m.status, tokens: m.usage?.total_tokens ?? task.tokens, toolUses: m.usage?.tool_uses ?? task.toolUses });
        return;
      }
    }
  }

  private putTask(task: TaskInfo): void {
    this.tasks.set(task.id, task);
    this.emit({ e: 'task', task });
  }

  private adoptSession(id: string): void {
    if (!id || id === this.row.sessionId) return;
    this.row.sessionId = id;
    this.host.save(this.row);
    // A tab nobody opened for Claude OS itself holds the user's work: '' says so, whatever its folder.
    const source = this.row.source ?? (this.row.kind === 'root' ? 'root' : this.row.kind === 'service' ? 'service' : '');
    this.ctx.journal.markOsSession(id, source, this.row.sourceDetail ?? undefined);
    recordCardSession(this.ctx, this.row.id, id);
    this.ctx.invalidate('tabs', 'sessions');
  }

  // A background task finishing can start a turn nobody sent.
  private ensureTurn(): void {
    if (!this.turn) this.setTurn(true);
  }

  private emit(body: EventBody): void {
    const event = { ...body, seq: ++this.seq, at: Date.now() } as ChatEvent;
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);
    this.host.publish(this.row.id, event);
  }
}

function planText(input: Record<string, unknown>): string {
  if (typeof input.plan === 'string') return input.plan;
  if (typeof input.planFilePath === 'string') {
    try { return readFileSync(input.planFilePath, 'utf8'); } catch { /* shown as empty */ }
  }
  return '';
}
