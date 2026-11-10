import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { forkSession, type Options, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { OS_SOURCES, type ChatEvent, type MessageKey, type NewTabRequest, type OsSource, type RecoveryItem, type ServerMessage, type SessionInfo, type Tab } from '../../shared/contract.ts';
import type { Ctx, ServiceJobHooks, ServiceJobOptions } from '../context.ts';
import { childOf, computeLive, endProcess, procStartOf, readRegistry, sameProcess, type ProcRef } from '../journal/live.ts';
import { findJournal, readTranscriptAsync } from '../journal/parse.ts';
import { probeCli } from './probe.ts';
import { promptKindOf, sessionProfileBlock } from './profile.ts';
import { createPlannerMcp, createRootMcp, createServiceMcp, createServiceTaskMcp, DOCUMENT_TOOLS, MEMORY_SEARCH_TOOL, PROGRESS_TOOL, ROOT_DISPATCH_TOOLS, ROOT_KANBAN_TOOLS, ROOT_MCP_NAME, ROOT_PLANNER_TOOLS, ROOT_PROJECT_TOOLS, ROOT_READ_TOOLS, SERVICE_TASK_TOOLS, SERVICE_TOOLS, UI_TOOL, WORK_KANBAN_TOOLS, WORK_PLANNER_TOOL } from './rootMcp.ts';
import { ServiceTasks } from './serviceTasks.ts';
import { withSetupTools } from './setupMcp.ts';
import type { OutgoingMessage } from './files.ts';
import { HttpError, TabSession, type ProgressReport, type SessionHost, type StoredProgress, type TabRow } from './session.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SERVICE_ERROR_LENGTH = 300;
const SERVICE_TASK_MS = 15 * 60_000; // the user waits for it, and it can read more than a note
const CONTINUE_KEY = 'continue_after_restart';
const CONTINUE_DELAY_MS = 1500; // every module is registered and the port is open by then
const CLOSED_CHILD_GRACE_MS = 3000; // a closed tab's process, before SIGKILL
const CONTINUE_RETRY_MS = 10_000; // the old process can still sit in the registry for a few seconds
const CONTINUE_TEXT = 'The Claude OS server was restarted on request and the turn was cut off. Continue the work from where you stopped.';

type Row = Record<string, string | number | null>;

function fromDb(r: Row): TabRow {
  return {
    id: r.id as string,
    kind: r.kind as Tab['kind'],
    project: r.project as string | null,
    cwd: r.cwd as string,
    sessionId: r.session_id as string | null,
    title: r.title as string,
    order: r.ord as number,
    model: r.model as string | null,
    effort: r.effort as string | null,
    worktree: r.worktree === 1,
    turnOpen: r.turn_open === 1,
    interruptedAt: r.interrupted_at as number | null,
    // Going without checks is a decision for one run of the app, it does not come back by itself.
    permissionMode: r.permission_mode === 'bypassPermissions' ? null : r.permission_mode as string | null,
    document: r.document as string | null,
    source: r.source as OsSource | null,
    sourceDetail: r.source_detail as string | null,
  };
}

export class Chat implements SessionHost {
  ctx: Ctx;
  idleMs = Number(process.env.CLAUDE_OS_TAB_IDLE_MS ?? 15 * 60_000);
  private sessions = new Map<string, TabSession>();
  private subscribers = new Map<string, Map<number, (m: ServerMessage) => void>>();
  private modelsCache: Promise<{ id: string; label: string }[]> | null = null;
  serviceJobMs = Number(process.env.CLAUDE_OS_SERVICE_JOB_MS ?? 5 * 60_000);
  private serviceJobs: { prompt: string; hooks: ServiceJobHooks; options: ServiceJobOptions }[] = [];
  private serviceRunning: { hooks: ServiceJobHooks; timer: NodeJS.Timeout; task: boolean; tools: readonly string[] } | null = null;
  tasks: ServiceTasks;
  // sessionId -> the process of a closed tab: the SDK lets it live for seconds after close. A reopen ends it first.
  private closedChildren = new Map<string, ProcRef>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, cwd TEXT NOT NULL, session_id TEXT, title TEXT NOT NULL,
      ord INTEGER NOT NULL, model TEXT, effort TEXT, worktree INTEGER NOT NULL DEFAULT 0, turn_open INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = (ctx.db.prepare('PRAGMA table_info(tabs)').all() as Row[]).map((c) => c.name);
    if (!columns.includes('permission_mode')) ctx.db.exec('ALTER TABLE tabs ADD COLUMN permission_mode TEXT');
    if (!columns.includes('interrupted_at')) ctx.db.exec('ALTER TABLE tabs ADD COLUMN interrupted_at INTEGER');
    if (!columns.includes('document')) ctx.db.exec('ALTER TABLE tabs ADD COLUMN document TEXT');
    if (!columns.includes('source')) ctx.db.exec('ALTER TABLE tabs ADD COLUMN source TEXT');
    if (!columns.includes('source_detail')) ctx.db.exec('ALTER TABLE tabs ADD COLUMN source_detail TEXT');
    ctx.db.exec('CREATE TABLE IF NOT EXISTS tab_queue (id TEXT PRIMARY KEY, tab TEXT NOT NULL, ord INTEGER NOT NULL, message TEXT NOT NULL)');
    ctx.db.exec('CREATE TABLE IF NOT EXISTS tab_progress (tab TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const progress = new Map((ctx.db.prepare('SELECT tab, value FROM tab_progress').all() as { tab: string; value: string }[]).map((p) => [p.tab, JSON.parse(p.value) as StoredProgress]));
    for (const r of ctx.db.prepare('SELECT * FROM tabs').all() as Row[]) {
      const session = new TabSession(fromDb(r), this);
      this.sessions.set(session.row.id, session);
      session.progress = progress.get(session.row.id) ?? null;
      // Nothing here starts a turn: a cut-off turn and a waiting queue only get listed for a decision.
      session.held = (ctx.db.prepare('SELECT id, message FROM tab_queue WHERE tab = ? ORDER BY ord').all(session.row.id) as { id: string; message: string }[])
        .map((q) => ({ id: q.id, message: JSON.parse(q.message) as OutgoingMessage }));
      if (session.row.kind === 'service') {
        session.row.turnOpen = false; // its job is over with the process, and the note says so by staying in the inbox
        session.row.interruptedAt = null;
        this.save(session.row);
      } else if (session.row.turnOpen || session.row.interruptedAt) session.markInterruptedByRestart();
    }
    ctx.db.exec('CREATE TABLE IF NOT EXISTS chat_meta (k TEXT PRIMARY KEY, v TEXT)');
    this.ensureRoot();
    this.tasks = new ServiceTasks(ctx, this);
    this.continueAfterRestart();
    ctx.bus.on('turn-finished', (id) => {
      if (this.serviceRunning && this.sessions.get(id)?.row.kind === 'service') this.endServiceJob(serviceOutcome(this.sessions.get(id)!));
    });
  }

  private ensureRoot(): void {
    const { root } = this.ctx.paths;
    mkdirSync(root, { recursive: true });
    const existing = [...this.sessions.values()].find((s) => s.row.kind === 'root');
    if (existing) {
      if (existing.row.cwd !== root) { // the repository moved
        existing.row.cwd = root;
        this.save(existing.row);
      }
      return;
    }
    this.add({ id: randomUUID(), kind: 'root', project: null, cwd: root, sessionId: null, title: 'Home', order: 0, model: null, effort: null, worktree: false, turnOpen: false, interruptedAt: null, permissionMode: null });
  }

  private add(row: TabRow): TabSession {
    const session = new TabSession(row, this);
    this.sessions.set(row.id, session);
    this.save(row);
    return session;
  }

  // ---------- The service session ----------

  // A hidden tab, made on the first job. Filing needs no memory of the notes before it, so each job gets a new
  // conversation and its process ends with it: the context does not grow and nothing idles.
  runServiceJob(prompt: string, hooks: ServiceJobHooks, options: ServiceJobOptions = {}): void {
    this.serviceJobs.push({ prompt, hooks, options });
    this.nextServiceJob();
  }

  private serviceSession(): TabSession {
    const { service } = this.ctx.paths;
    const existing = [...this.sessions.values()].find((s) => s.row.kind === 'service');
    if (existing) {
      if (existing.row.cwd !== service) { // the repository moved
        existing.row.cwd = service;
        this.save(existing.row);
      }
      return existing;
    }
    mkdirSync(service, { recursive: true });
    return this.add({ id: randomUUID(), kind: 'service', project: null, cwd: service, sessionId: null, title: 'Service', order: 0, model: null, effort: null, worktree: false, turnOpen: false, interruptedAt: null, permissionMode: null });
  }

  private nextServiceJob(): void {
    if (this.serviceRunning) return;
    const job = this.serviceJobs.shift();
    if (!job) return;
    const session = this.serviceSession();
    // Nobody can see or stop this session: a turn that hangs must end by itself.
    const task = job.options.task === true;
    const timer = setTimeout(() => this.endServiceJob({ error: 'The job took too long and was stopped', key: 'jobTooLong' }), task ? Math.max(this.serviceJobMs, SERVICE_TASK_MS) : this.serviceJobMs);
    timer.unref();
    this.serviceRunning = { hooks: job.hooks, timer, task, tools: job.options.tools ?? [] };
    job.hooks.start();
    try {
      session.reset();
      session.row.source = job.options.source ?? null; // each job is a new conversation, marked with what asked for it
      session.row.sourceDetail = job.options.sourceDetail ?? null;
      if (job.options.resume) {
        session.row.sessionId = job.options.resume;
        this.save(session.row);
      }
      session.send({ text: job.prompt });
      if (!session.turn) this.endServiceJob(serviceOutcome(session) ?? { error: 'Claude did not start', key: 'jobNoStart' });
    } catch (err) {
      const { message, key, params } = err as HttpError;
      this.endServiceJob({ error: message, key, params });
    }
  }

  private endServiceJob(failure: ServiceFailure | null): void {
    const job = this.serviceRunning;
    if (!job) return;
    this.serviceRunning = null;
    clearTimeout(job.timer);
    const session = this.serviceSession();
    const outcome = { text: lastText(session), sessionId: session.row.sessionId };
    session.halt();
    job.hooks.end(failure?.error ?? null, outcome, failure ? { key: failure.key, params: failure.params } : undefined);
    this.nextServiceJob();
  }

  /** The owner's interrupt: a job waiting in line leaves it, a running one stops. */
  cancelServiceJob(hooks: ServiceJobHooks, reason: ServiceFailure): void {
    const waiting = this.serviceJobs.findIndex((j) => j.hooks === hooks);
    if (waiting >= 0) {
      this.serviceJobs.splice(waiting, 1);
      hooks.end(reason.error, undefined, { key: reason.key, params: reason.params });
    } else if (this.serviceRunning?.hooks === hooks) this.endServiceJob(reason);
  }

  private dropServiceJobs(reason: ServiceFailure): void {
    for (const { hooks } of this.serviceJobs.splice(0)) hooks.end(reason.error, undefined, { key: reason.key, params: reason.params });
    this.endServiceJob(reason);
  }

  // How the user signs in and their model, without their hooks, plugins, MCP servers and CLAUDE.md: those are for their sessions.
  private serviceSettings(): Settings {
    const { env, apiKeyHelper, model } = readUserSettings(this.ctx.paths.claudeDir);
    return { autoMemoryEnabled: false, ...(env ? { env } : {}), ...(apiKeyHelper ? { apiKeyHelper } : {}), ...(model ? { model } : {}) } as Settings;
  }

  // ---------- SessionHost ----------

  save(r: TabRow): void {
    this.ctx.db.prepare(`INSERT OR REPLACE INTO tabs (id, kind, project, cwd, session_id, title, ord, model, effort, worktree, turn_open, interrupted_at, permission_mode, document, source, source_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.kind, r.project, r.cwd, r.sessionId, r.title, r.order, r.model, r.effort, r.worktree ? 1 : 0, r.turnOpen ? 1 : 0, r.interruptedAt, r.permissionMode, r.document ?? null, r.source ?? null, r.sourceDetail ?? null);
  }

  saveQueue(tabId: string, items: { id: string; message: OutgoingMessage }[]): void {
    this.ctx.db.prepare('DELETE FROM tab_queue WHERE tab = ?').run(tabId);
    const insert = this.ctx.db.prepare('INSERT INTO tab_queue (id, tab, ord, message) VALUES (?, ?, ?, ?)');
    items.forEach((q, i) => insert.run(q.id, tabId, i, JSON.stringify(q.message)));
  }

  saveProgress(tabId: string, progress: StoredProgress | null): void {
    if (progress) this.ctx.db.prepare('INSERT OR REPLACE INTO tab_progress (tab, value) VALUES (?, ?)').run(tabId, JSON.stringify(progress));
    else this.ctx.db.prepare('DELETE FROM tab_progress WHERE tab = ?').run(tabId);
  }

  reportProgress(tabId: string, report: ProgressReport): void {
    this.sessions.get(tabId)?.report(report);
  }

  publish(tabId: string, event: ChatEvent): void {
    const subs = this.subscribers.get(tabId);
    if (!subs) return;
    for (const send of subs.values()) send({ t: 'chat', tabId, event });
  }

  neighbours(session: TabSession): TabSession[] {
    return [...this.sessions.values()].filter((s) => s !== session && s.row.kind !== 'readonly' && s.row.cwd === session.row.cwd);
  }

  private journalSession(id: string): SessionInfo | undefined {
    return this.ctx.journal.listSessions().find((s) => s.id === id);
  }

  // The registry is read at the moment of asking: the cached list lags it, and a second writer must not slip through the gap.
  private runningOutside(sessionId: string): { pid: number | null } | null {
    // A closed tab's process counts too until settleClosedChild has ended it: never two writers.
    const fresh = computeLive(readRegistry(this.ctx.paths.claudeDir), []).get(sessionId);
    if (fresh) return fresh;
    const s = this.journalSession(sessionId);
    // The cached look can still show a process that is gone.
    if (!s || s.status === 'ended' || (s.pid !== null && procStartOf(s.pid) === null)) return null;
    return s;
  }

  /** The process of this session's closed tab while it is still that process; forgotten once it is gone. */
  private closedChild(sessionId: string): ProcRef | null {
    const ref = this.closedChildren.get(sessionId);
    if (!ref) return null;
    if (sameProcess(ref)) return ref;
    this.closedChildren.delete(sessionId);
    return null;
  }

  /** Reopened while the closed tab's process is still on its way out: it ends before a new one may start. */
  async settleClosedChild(sessionId: string): Promise<void> {
    const ref = this.closedChild(sessionId);
    if (!ref) return;
    await endProcess(ref, CLOSED_CHILD_GRACE_MS);
    this.closedChildren.delete(sessionId);
  }

  assertNotLiveElsewhere(sessionId: string): void {
    const s = this.runningOutside(sessionId);
    const pid = s?.pid ? ` (pid ${s.pid})` : '';
    if (s) throw new HttpError(409, `Session ${sessionId} is still alive${pid}: a running session cannot be attached. End it in the terminal and try again.`, 'sessionAlive', { id: sessionId, pid });
  }

  sessionHolder(sessionId: string): { where: 'tab' | 'terminal'; pid: number | null } | null {
    for (const s of this.sessions.values()) if (s.row.sessionId === sessionId && s.hasProcess()) return { where: 'tab', pid: null };
    const outside = this.runningOutside(sessionId);
    return outside && { where: 'terminal', pid: outside.pid };
  }

  readStatus(row: TabRow) {
    return (row.sessionId && this.journalSession(row.sessionId)?.status) || 'ended';
  }

  extraOptions(row: TabRow): Partial<Options> {
    const options = this.tabOptions(row);
    return row.id === this.ctx.settings?.setup().tabId ? withSetupTools(this.ctx, row.id, options) : options;
  }

  private tabOptions(row: TabRow): Partial<Options> {
    const profile = sessionProfileBlock(this.ctx, promptKindOf(this.ctx.paths, row));
    const systemPrompt: Options['systemPrompt'] = { type: 'preset', preset: 'claude_code', ...(profile ? { append: profile } : {}) };
    if (row.kind === 'service' && this.serviceRunning?.task) {
      return {
        mcpServers: { [ROOT_MCP_NAME]: createServiceTaskMcp(this.ctx, this, this.serviceRunning.tools) },
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
        allowedTools: ['Read', 'Glob', 'Grep', ...SERVICE_TASK_TOOLS, ...this.serviceRunning.tools.map((t) => `mcp__${ROOT_MCP_NAME}__${t}`)],
        settingSources: ['project'],
        settings: this.serviceSettings(),
        systemPrompt,
        // Nobody answers a prompt here, so the rule is the prompt: its own settings folder and nothing else. The rest goes to a tab, where the user sees it.
        canUseTool: async (tool, input) => {
          const path = typeof input.file_path === 'string' ? resolve(row.cwd, input.file_path) : '';
          if ((tool === 'Edit' || tool === 'Write') && path.startsWith(`${this.ctx.paths.config}${sep}`)) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: `${tool}: only files in ${this.ctx.paths.config} can be changed here. Anything else: open_session with a full brief.` };
        },
      };
    }
    if (row.kind === 'service') {
      return {
        mcpServers: { [ROOT_MCP_NAME]: createServiceMcp(this.ctx) },
        tools: ['Read'], // a picture attached to a note; its folder is readable without a prompt
        allowedTools: SERVICE_TOOLS,
        settingSources: ['project'],
        settings: this.serviceSettings(),
        systemPrompt,
        canUseTool: async (tool) => ({ behavior: 'deny', message: `${tool}: a service job has nobody to ask` }),
      };
    }
    if (row.kind !== 'root') return { mcpServers: { [ROOT_MCP_NAME]: createPlannerMcp(this.ctx, row.id, row.title, row.project) }, allowedTools: [WORK_PLANNER_TOOL, MEMORY_SEARCH_TOOL, UI_TOOL, PROGRESS_TOOL, ...WORK_KANBAN_TOOLS, ...DOCUMENT_TOOLS, `mcp__${ROOT_MCP_NAME}__kit_plan`] };
    return { mcpServers: { [ROOT_MCP_NAME]: createRootMcp(this.ctx, this, row.id, row.title) }, allowedTools: [...ROOT_READ_TOOLS, ...ROOT_PLANNER_TOOLS, ...ROOT_KANBAN_TOOLS, ...ROOT_DISPATCH_TOOLS, ...ROOT_PROJECT_TOOLS, UI_TOOL, PROGRESS_TOOL, ...DOCUMENT_TOOLS] };
  }

  private rules: string | null = null;
  noteRules(): string {
    this.rules ??= safelyRead(join(this.ctx.paths.root, 'NOTE_RULES.md'));
    return this.rules;
  }

  rememberTerminalCommands(names: string[]): void {
    this.ctx.db.prepare('INSERT OR REPLACE INTO chat_meta (k, v) VALUES (?, ?)').run('terminal_commands', JSON.stringify(names));
  }

  terminalCommands(): string[] {
    const row = this.ctx.db.prepare('SELECT v FROM chat_meta WHERE k = ?').get('terminal_commands') as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as string[]) : [];
  }

  tabInfo(id: string): { cwd: string; project: string | null; kind: string } {
    const { row } = this.get(id);
    return { cwd: row.cwd, project: row.project, kind: row.kind };
  }

  liveCommands(id: string) {
    return this.get(id).commands();
  }

  // ---------- Tabs ----------

  get(id: string): TabSession {
    const session = this.sessions.get(id);
    if (!session || session.row.kind === 'service') throw new HttpError(404, 'Tab not found', 'tabNotFound');
    return session;
  }

  list(): Tab[] {
    return [...this.sessions.values()].filter((s) => s.row.kind !== 'service').map((s) => s.toTab()).sort((a, b) => a.order - b.order);
  }

  private documentTab(id: string): TabSession | undefined {
    return [...this.sessions.values()].find((s) => s.row.document === id);
  }

  openDocument(doc: { id: string; title: string; project: string | null }): Tab {
    const existing = this.documentTab(doc.id);
    if (existing) return existing.toTab();
    const root = doc.project ? this.ctx.journal.listProjects(true).find((p) => p.key === doc.project)?.root : undefined;
    // A document without a project, or of one whose folder is gone, is edited from the root folder.
    const home = root && existsSync(root) ? root : undefined;
    return this.create({ project: home && doc.project ? doc.project : undefined, cwd: home ?? this.ctx.paths.root, title: doc.title }, doc.id);
  }

  closeDocument(id: string): void {
    const tab = this.documentTab(id);
    if (tab) this.close(tab.row.id);
  }

  renameDocument(id: string, title: string): void {
    const tab = this.documentTab(id);
    if (!tab || tab.row.title === title) return;
    tab.row.title = title;
    this.save(tab.row);
    this.ctx.invalidate('tabs');
  }

  create(req: NewTabRequest, document: string | null = null): Tab {
    const resumeId = req.resumeSessionId ?? null;
    if (req.readonly && !resumeId) throw new HttpError(400, 'A read-only tab needs resumeSessionId', 'readonlyNeedsResume');
    const known = resumeId ? this.journalSession(resumeId) : undefined;
    if (resumeId && !req.readonly) {
      this.assertNotLiveElsewhere(resumeId);
      if ([...this.sessions.values()].some((s) => s.row.kind !== 'readonly' && s.row.sessionId === resumeId)) {
        throw new HttpError(409, 'This session is already open in another tab', 'sessionOpenElsewhere');
      }
    }
    const project = req.project ? this.ctx.journal.listProjects(true).find((p) => p.key === req.project) : undefined;
    if (req.project && !project && !req.cwd && !known) throw new HttpError(404, `Project not found: ${req.project}`, 'projectNotFound', { project: req.project });
    const cwd = known?.cwd || req.cwd || project?.root; // the journal may know an id before it knows the cwd
    if (!cwd) throw new HttpError(400, 'Needs project, cwd or a known resumeSessionId', 'needCwd');
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); } catch { /* reported below */ }
    if (!isDir) throw new HttpError(400, `Directory does not exist: ${cwd}`, 'dirMissing', { cwd });
    if (req.worktree && !resumeId) {
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore', timeout: 5000 });
      } catch {
        throw new HttpError(400, `A separate worktree needs a git repository, and ${cwd} is not one`, 'worktreeNeedsGit', { cwd });
      }
    }
    assertModel(req.model);
    assertEffort(req.effort);
    // The root session's folder is part of Claude OS, as its sessions are in the journal.
    const inRootFolder = cwd === this.ctx.paths.root || cwd.startsWith(`${this.ctx.paths.root}/`);
    // The first-run setup tab belongs to no project: no project row, no notes folder, no state note.
    const projectKey = cwd === this.ctx.paths.setup ? null : req.project ?? known?.project ?? this.ctx.journal.projectForCwd(inRootFolder ? this.ctx.paths.repo : cwd);
    // A new session starts from the project's defaults; a resumed one keeps what it had.
    const defaults = projectKey && !resumeId ? this.ctx.settings?.projectDefaults(projectKey) : undefined;
    const orders = [...this.sessions.values()].map((s) => s.row.order);
    const session = this.add({
      id: randomUUID(),
      kind: req.readonly ? 'readonly' : document ? 'document' : 'work',
      document,
      project: projectKey,
      cwd,
      sessionId: resumeId,
      title: req.title?.trim() || known?.title || project?.name || basename(cwd),
      order: Math.max(0, ...orders) + 1,
      model: req.model ?? defaults?.model ?? null,
      effort: req.effort ?? defaults?.effort ?? null,
      worktree: !req.readonly && !resumeId && req.worktree === true,
      turnOpen: false,
      interruptedAt: null,
      permissionMode: null,
      source: OS_SOURCES.includes(req.source as OsSource) ? req.source! : null, // from the page: an unknown value is ignored
      sourceDetail: OS_SOURCES.includes(req.source as OsSource) ? req.sourceDetail ?? null : null,
    });
    if (resumeId && !req.readonly) this.ctx.journal.dismissLost(resumeId); // it has a tab now
    this.ctx.invalidate('tabs');
    return session.toTab();
  }

  // /branch: the SDK copies the journal under a new id, no process and no tokens. The tab resumes the copy on its first message.
  // The title comes from the page, in its language.
  async branch(id: string, title?: string): Promise<Tab> {
    const { row } = this.get(id);
    if (!row.sessionId) throw new HttpError(409, 'Nothing to copy in this conversation yet', 'nothingToBranch');
    const { sessionId } = await forkSession(row.sessionId, { dir: row.cwd });
    // The tab starts on the copy's id, so adoptSession never sees it new: the copy is marked here.
    this.ctx.journal.markOsSession(sessionId, row.source ?? '', row.sourceDetail ?? undefined);
    return this.create({ resumeSessionId: sessionId, cwd: row.cwd, project: row.project ?? undefined, title: title || `${row.title} (branch)`, source: row.source ?? undefined, sourceDetail: row.sourceDetail ?? undefined });
  }

  async update(id: string, body: { title?: string; order?: number; model?: string | null; effort?: string | null; permissionMode?: string }): Promise<Tab> {
    const session = this.get(id);
    const { row } = session;
    if (typeof body.title === 'string' && body.title.trim()) row.title = body.title.trim();
    if (typeof body.order === 'number') row.order = body.order;
    if (body.model !== undefined) {
      assertModel(body.model);
      await session.applyModel(body.model);
    }
    if (body.effort !== undefined) {
      assertEffort(body.effort);
      await session.applyEffort(body.effort);
    }
    if (body.permissionMode !== undefined) await session.applyPermissionMode(body.permissionMode);
    this.save(row);
    this.ctx.invalidate('tabs');
    return session.toTab();
  }

  close(id: string): void {
    const session = this.get(id);
    if (session.row.kind === 'root') throw new HttpError(403, 'The Home tab cannot be closed', 'rootTabClose');
    const { sessionId } = session.row;
    const child = sessionId && session.hasProcess() ? childOf(readRegistry(this.ctx.paths.claudeDir), sessionId, process.pid) : null;
    if (sessionId && child) this.closedChildren.set(sessionId, child);
    session.dispose();
    this.sessions.delete(id);
    this.subscribers.delete(id);
    this.ctx.db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
    this.ctx.db.prepare('DELETE FROM tab_queue WHERE tab = ?').run(id);
    this.saveProgress(id, null);
    rmSync(session.uploadDir(), { recursive: true, force: true });
    this.ctx.invalidate('tabs', 'sessions');
  }

  stopSession(sessionId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.row.kind !== 'readonly' && s.row.sessionId === sessionId && s.halt()) {
        this.ctx.invalidate('tabs', 'sessions');
        return true;
      }
    }
    return false;
  }

  // The window's "stop everything": every process a tab runs. The tabs and their journals stay.
  stopAll(): number {
    let stopped = 0;
    for (const s of this.sessions.values()) {
      if (s.row.kind === 'readonly') continue;
      if (s.row.kind !== 'service') s.holdForStop();
      if (s.halt()) stopped++;
    }
    this.dropServiceJobs({ error: 'Stopped with everything else', key: 'jobStoppedAll' });
    return stopped;
  }

  sessionTabs(sessionId: string): { kind: string; status: string }[] {
    return [...this.sessions.values()].filter((s) => s.row.sessionId === sessionId).map((s) => ({ kind: s.row.kind, status: s.status() }));
  }

  closeSessionTabs(sessionId: string): void {
    for (const s of [...this.sessions.values()]) if (s.row.sessionId === sessionId && s.row.kind !== 'root' && s.row.kind !== 'service') this.close(s.row.id);
  }

  projectTabs(key: string): number {
    return [...this.sessions.values()].filter((s) => s.row.project === key && s.row.kind !== 'root').length;
  }

  closeProjectTabs(key: string): void {
    for (const s of [...this.sessions.values()]) if (s.row.project === key && s.row.kind !== 'root') this.close(s.row.id);
  }

  // Used by the root session's tools: the tab appears for the user at once, then the turn starts.
  // A batch keeps the user where they are: only `focus` takes them there.
  openWithPrompt(req: NewTabRequest, prompt: string, opts: { focus?: boolean; permissionMode?: string } = {}): { tabId: string; cwd: string; title: string } {
    const tab = this.create(req);
    if (opts.permissionMode) {
      const session = this.get(tab.id);
      session.row.permissionMode = opts.permissionMode;
      this.save(session.row);
    }
    this.ctx.broadcast({ t: 'tab_opened', tab: this.get(tab.id).toTab(), focus: opts.focus ?? true });
    this.get(tab.id).send({ text: prompt });
    return { tabId: tab.id, cwd: tab.cwd, title: tab.title };
  }

  // An old session goes on in a tab: the one that already holds it, or a new one. A fresh process loads the project's MCP anew.
  resumeInTab(sessionId: string, prompt?: string): { tabId: string; cwd: string; title: string; reused: boolean } {
    const held = [...this.sessions.values()].find((s) => s.row.kind !== 'readonly' && s.row.sessionId === sessionId);
    if (!held && !this.journalSession(sessionId)) throw new HttpError(404, `Session ${sessionId} not found. list_sessions gives the ids.`, 'sessionNotFound', { id: sessionId });
    const session = held ?? this.get(this.create({ resumeSessionId: sessionId }).id);
    this.ctx.broadcast({ t: 'tab_opened', tab: session.toTab(), focus: true });
    if (prompt) session.send({ text: prompt });
    return { tabId: session.row.id, cwd: session.row.cwd, title: session.row.title, reused: Boolean(held) };
  }

  // ---------- After a restart ----------

  // A restart ordered with "go on": the tabs in the middle of work get one message each when the server is back.
  // Only here does anything start by itself after a restart, because the one who ordered it has said so.
  planContinue(): number {
    const ids = [...this.sessions.values()].filter((s) => s.row.kind !== 'readonly' && s.row.kind !== 'service' && s.working()).map((s) => s.row.id);
    this.ctx.db.prepare('INSERT OR REPLACE INTO chat_meta (k, v) VALUES (?, ?)').run(CONTINUE_KEY, JSON.stringify(ids));
    return ids.length;
  }

  private continueAfterRestart(): void {
    const row = this.ctx.db.prepare('SELECT v FROM chat_meta WHERE k = ?').get(CONTINUE_KEY) as { v: string } | undefined;
    if (!row) return;
    this.ctx.db.prepare('DELETE FROM chat_meta WHERE k = ?').run(CONTINUE_KEY);
    setTimeout(() => {
      for (const id of JSON.parse(row.v) as string[]) this.continueTab(id, Date.now() + CONTINUE_RETRY_MS, 250);
    }, CONTINUE_DELAY_MS).unref();
  }

  private continueTab(id: string, deadline: number, wait: number, retry = false): void {
    const session = this.sessions.get(id);
    // Meanwhile the user went on himself: one more message would be a second answer to the same thing.
    if (!session || (retry && (session.turn || session.hasProcess()))) return;
    try {
      session.send({ text: CONTINUE_TEXT });
    } catch (err) {
      if ((err as HttpError).key === 'sessionAlive' && Date.now() + wait <= deadline) {
        setTimeout(() => this.continueTab(id, deadline, Math.min(wait * 2, 2000), true), wait).unref();
        return;
      }
      console.warn(`continue after restart, tab ${id}:`, (err as Error).message); // still listed for the user to decide
    }
  }

  // What a restart or a reboot cut off, for the user to continue or close. Terminal sessions come from the journal.
  recovery(): RecoveryItem[] {
    const tabs = [...this.sessions.values()].filter((s) => s.row.kind !== 'service' && s.row.kind !== 'readonly' && (s.row.interruptedAt !== null || s.held.length > 0));
    const opened = new Set([...this.sessions.values()].map((s) => s.row.sessionId));
    return [
      ...tabs.map((s): RecoveryItem => ({
        kind: 'tab',
        tabId: s.row.id,
        tabKind: s.row.kind,
        title: s.row.title,
        project: s.row.project,
        sessionId: s.row.sessionId,
        interruptedAt: s.row.interruptedAt,
        queued: s.held.map((q) => ({ id: q.id, text: q.message.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' '), attachments: q.message.blocks.filter((b) => b.type !== 'text').length })),
      })),
      ...this.ctx.journal.lostSessions().filter((s) => !opened.has(s.id)).map((s): RecoveryItem => ({
        kind: 'session',
        sessionId: s.id,
        title: s.title ?? s.name ?? s.lastPrompt ?? `${basename(s.cwd)} · ${s.id.slice(0, 8)}`,
        project: s.project,
        cwd: s.cwd,
        lastActivity: s.lastActivity,
      })),
    ];
  }

  recoverable(id: string): TabSession {
    const session = this.get(id);
    if (session.row.kind === 'readonly') throw new HttpError(404, 'Tab not found', 'tabNotFound');
    return session;
  }

  // ---------- History and streaming ----------

  // The transcript holds everything before this server run; the buffer holds this run. Live events win.
  async history(id: string): Promise<ChatEvent[]> {
    const session = this.get(id);
    const { sessionId, cwd } = session.row;
    const live = session.buffer;
    let transcript: ChatEvent[] = [];
    if (sessionId) {
      try {
        const path = findJournal(sessionId, cwd, this.ctx.paths.claudeDir);
        if (path) transcript = await readTranscriptAsync(path);
      } catch (err) {
        this.ctx.app.log.warn(err);
      }
    }
    const firstLive = live[0]?.at ?? Infinity;
    const messageIds = new Set<string>();
    const toolIds = new Set<string>();
    for (const e of live) {
      if (e.e === 'assistant') messageIds.add(e.messageId);
      if (e.e === 'tool_result') toolIds.add(e.toolUseId);
    }
    const older = transcript.filter((e) => e.at < firstLive
      && !(e.e === 'assistant' && messageIds.has(e.messageId))
      && !(e.e === 'tool_result' && toolIds.has(e.toolUseId)));
    return [...older, ...live];
  }

  subscribe(tabId: string, connId: number, lastSeq: number, send: (m: ServerMessage) => void): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    // Synchronous: nothing can be emitted between the replay and joining the live stream.
    for (const event of session.buffer) if (event.seq > lastSeq) send({ t: 'chat', tabId, event });
    let subs = this.subscribers.get(tabId);
    if (!subs) this.subscribers.set(tabId, subs = new Map());
    subs.set(connId, send);
  }

  unsubscribe(tabId: string, connId: number): void {
    this.subscribers.get(tabId)?.delete(connId);
  }

  dropConnection(connId: number): void {
    for (const subs of this.subscribers.values()) subs.delete(connId);
  }

  // ---------- Models ----------

  models(): Promise<{ id: string; label: string }[]> {
    this.modelsCache ??= this.askCliForModels().catch((err) => {
      this.modelsCache = null; // retry on the next request
      this.ctx.app.log.warn(err);
      return this.modelFromSettings();
    });
    return this.modelsCache;
  }

  // The list comes from the CLI's initialize answer: no prompt is sent, so no tokens. No settings, MCP or hooks are loaded.
  private async askCliForModels(): Promise<{ id: string; label: string }[]> {
    const models = await probeCli(this.ctx, this.ctx.paths.root, false, (q) => q.supportedModels());
    return models.map((m) => ({ id: m.value, label: m.displayName }));
  }

  private modelFromSettings(): { id: string; label: string }[] {
    const { model } = readUserSettings(this.ctx.paths.claudeDir);
    return typeof model === 'string' && model ? [{ id: model, label: model }] : [];
  }
}

function readUserSettings(claudeDir: string): { env?: Record<string, string>; apiKeyHelper?: string; model?: unknown } {
  try {
    return JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// What it said last: a service job's answer to the user.
function lastText(session: TabSession): string | null {
  for (let i = session.buffer.length - 1; i >= 0; i--) {
    const e = session.buffer[i];
    if (e.e !== 'assistant') continue;
    const text = e.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (text) return text;
  }
  return null;
}

// A service job's failure: the text, and the key the UI shows instead.
export type ServiceFailure = { error: string } & MessageKey;

// Why the session's last turn failed, if it did.
function serviceOutcome(session: TabSession): ServiceFailure | null {
  for (let i = session.buffer.length - 1; i >= 0; i--) {
    const e = session.buffer[i];
    if (e.e === 'result') {
      if (e.interrupted) return { error: 'The turn was interrupted', key: 'turnInterrupted' };
      return e.error ? { error: e.error.slice(0, SERVICE_ERROR_LENGTH), key: e.key, params: e.params } : null;
    }
    if (e.e === 'error') return { error: e.text.slice(0, SERVICE_ERROR_LENGTH), key: e.key, params: e.params };
  }
  return null;
}

function safelyRead(path: string): string {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function assertModel(model: string | null | undefined): void {
  if (model != null && !/^[A-Za-z0-9][\w.:\-\[\]]*$/.test(model)) throw new HttpError(400, `Invalid model name: ${model}`, 'badModel', { model });
}

function assertEffort(effort: string | null | undefined): void {
  if (effort != null && !EFFORTS.includes(effort)) throw new HttpError(400, `Effort must be one of: ${EFFORTS.join(', ')}`, 'badEffort', { list: EFFORTS.join(', ') });
}
