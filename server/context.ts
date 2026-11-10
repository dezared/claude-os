import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { GuardDecision } from './memory/guard.ts';
import type { KitApi } from './tools/projectKit.ts';
import type { MemorySearchHit, MessageKey, NewTabRequest, OsSource, Profile, Project, ProjectPatch, SendRequest, ServerMessage, ServiceTask, SessionInfo, SettingsView, SetupState, Tab, Topic } from '../shared/contract.ts';

export interface Paths {
  repo: string;
  data: string; // SQLite, backups, approvals: sessions reach only data/planner, to read
  config: string; // projects.json, actions.json, widgets.json, settings.json
  plugins: string; // shipped Claude OS plugins; config/plugins holds the user's, and the same id there wins
  root: string; // cwd of the root session
  service: string; // cwd of the hidden service session: beside root/, so root/CLAUDE.md does not reach it
  setup: string; // cwd of the first-run setup tab and home of its SETUP.md, beside root/ for the same reason
  claudeDir: string; // ~/.claude or CLAUDE_CONFIG_DIR
  claudeJson: string; // ~/.claude.json
  claudeBin: string;
  vault: string;
  newProjectsDir: string; // CLAUDE_OS_NEW_PROJECTS or ~/Projects; the profile's projectsDir comes between them
}

// CLAUDE_OS_CLAUDE_BIN, then the first claude on PATH, then where the installer puts it.
export function resolveClaudeBin(o: { env: NodeJS.ProcessEnv; pathEnv: string; platform: NodeJS.Platform; home: string; exists: (p: string) => boolean }): string {
  if (o.env.CLAUDE_OS_CLAUDE_BIN) return o.env.CLAUDE_OS_CLAUDE_BIN;
  const path = o.platform === 'win32' ? win32 : posix;
  const names = o.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of o.pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (o.exists(path.join(dir, name))) return path.join(dir, name);
  }
  return path.join(o.home, '.local', 'bin', o.platform === 'win32' ? 'claude.exe' : 'claude');
}

export function resolvePaths(env = process.env): Paths {
  const repo = resolve(import.meta.dirname, '..');
  const home = homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const paths: Paths = {
    repo,
    data: env.CLAUDE_OS_DATA ?? join(repo, 'data'),
    config: env.CLAUDE_OS_CONFIG ?? join(repo, 'config'),
    plugins: env.CLAUDE_OS_PLUGINS ?? join(repo, 'plugins'),
    root: join(repo, 'root'),
    service: join(repo, 'service'),
    setup: join(repo, 'setup'),
    claudeDir,
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'),
    claudeBin: resolveClaudeBin({ env, pathEnv: env.PATH ?? '', platform: process.platform, home, exists: existsSync }),
    vault: env.CLAUDE_OS_VAULT ?? join(repo, 'vault'),
    newProjectsDir: env.CLAUDE_OS_NEW_PROJECTS ?? join(home, 'Projects'),
  };
  mkdirSync(paths.data, { recursive: true });
  return paths;
}

// Server-wide events for module-to-module signals, on top of the WebSocket broadcast.
export interface BusEvents {
  'sessions-changed': [];
  'session-origin': [sessionId: string]; // chat started a session: journal marks it as origin=os
  'rate-limit': [sessionId: string, raw: unknown];
  'turn-finished': [tabId: string];
}

// Module-to-module calls. Registration order in index.ts: journal, memory, tools, chat.
// Each register function assigns its own field; call the others at request time, not at register time.
export interface JournalApi {
  listProjects(includeEmpty?: boolean): Project[]; // empty = no sessions, no notes, not connected: hidden unless asked for
  listSessions(): SessionInfo[];
  projectForCwd(cwd: string): string | null; // Project.key, creates the project if it is new
  markOsSession(sessionId: string, source?: OsSource | '', detail?: string): void; // origin = os; '' = the user's work in a tab; a source once known stays
  setMapPin(key: string, on: boolean | null): Project | null;
  updateProject(key: string, patch: ProjectPatch): Project | null; // throws with the reason on a wrong value
  lostSessions(): SessionInfo[]; // terminal sessions a restart or reboot cut off, not yet continued or dismissed
  dismissLost(sessionId: string): void;
}

export interface ServiceJobHooks {
  start(): void;
  // error null: the turn ended normally, which does not yet say the job was done. message: the error's key for the UI.
  end(error: string | null, outcome?: { text: string | null; sessionId: string | null }, message?: MessageKey): void;
}

export interface ServiceJobOptions {
  task?: boolean; // the user's request: wider tools than filing a note, see Chat.extraOptions
  resume?: string; // the same conversation: an answer to the one question it asked
  source?: OsSource; // what asked for the job, for the analytics; none: the service's own work
  sourceDetail?: string;
  tools?: readonly string[]; // claude-os tools on top of the task's own, from its template (MICROTASK_TOOLS)
}

// Set by registerChat. Absent in tests of other modules.
export interface ChatApi {
  stopSession(sessionId: string): boolean; // true: it ran in a Claude OS tab and has been stopped
  stopAll(): number; // processes stopped
  planContinue(): number; // before a restart: the tabs at work get a "go on" after the boot
  sessionTabs(sessionId: string): { kind: string; status: string }[];
  closeSessionTabs(sessionId: string): void; // all but the root tab
  projectTabs(key: string): number;
  closeProjectTabs(key: string): void;
  tabInfo(id: string): { cwd: string; project: string | null; kind: string };
  list(): Tab[];
  create(req: NewTabRequest): Tab;
  // A new tab that starts on the prompt at once; focus false keeps the user where they are.
  openWithPrompt(req: NewTabRequest, prompt: string, opts?: { focus?: boolean; permissionMode?: string }): { tabId: string; cwd: string; title: string };
  // pendingPermission: the tool call an open permission card waits on, null when no such card is open.
  get(id: string): { send(req: SendRequest): void; pendingPermission(requestId: string): { tool: string; input: Record<string, unknown> } | null };
  liveCommands(id: string): Promise<{ name: string; description: string; argumentHint: string; builtin?: boolean }[] | null>; // null: no running process
  terminalCommands(): string[]; // reported by the CLI, remembered across restarts
  runServiceJob(prompt: string, job: ServiceJobHooks, options?: ServiceJobOptions): void; // queued: one at a time, in the hidden service session
  tasks: { start(body: { title?: string; prompt?: string; project?: string | null; modal?: boolean; link?: string; rounds?: number; source?: OsSource; sourceDetail?: string }): ServiceTask };
  sessionHolder(sessionId: string): { where: 'tab' | 'terminal'; pid: number | null } | null; // which process runs it now, null: none
  openDocument(doc: { id: string; title: string; project: string | null }): Tab; // its one tab, made when it is first opened
  closeDocument(id: string): void;
  renameDocument(id: string, title: string): void;
  reportProgress(tabId: string, report: { percent: number; step?: string; status?: 'working' | 'waiting' | 'done' | 'failed'; restart?: boolean }): void;
}

// Set by registerTools. Absent in tests of other modules.
export interface SettingsApi {
  projectDefaults(key: string): { model: string | null; effort: string | null };
  profile(): Profile | null; // null: not set up yet, or the stored one does not fit
  setProfile(patch: Partial<Profile>): SettingsView; // the validation of PUT /api/settings/profile, throws 400 with the reason
  setup(): SetupState;
  saveSetup(patch: Partial<SetupState>): void;
}

export interface MemoryApi {
  projectStats(key: string): { count: number; connected: boolean; drift: number };
  vaultDirFor(key: string): string | null; // the project's vault dir when connected, for --settings autoMemoryDirectory
  // The dir a Claude OS session writes notes to. Old notes are copied first, or a session would stop seeing them.
  prepareSessionDir(key: string): { dir: string; copied: number };
  stateNote(key: string): string | null; // contents of _state/<key>.md, up to 1000 chars
  // FTS over the notes; `[`/`]` mark the matches. project: only that one; boost: rank that one higher. limit 1-20, default 5.
  search(q: string, opts?: { limit?: number; project?: string | null; boost?: string | null }): (MemorySearchHit & { path: string })[];
  recentNotes(limit: number): { id: string; title: string; mtime: number }[]; // newest first
  touch?(): void; // files moved behind the watcher's back
  // PreToolUse check of a Claude OS session's tool call: deny a malformed vault note, null for no decision.
  guardTool(tabId: string, cwd: string, tool: string, input: Record<string, unknown>): GuardDecision;
}

export interface Ctx {
  journal: JournalApi;
  memory: MemoryApi;
  chat?: ChatApi;
  settings?: SettingsApi;
  kit?: KitApi; // set by registerTools: the project kit's plans and apply, for the kit MCP tools
  app: FastifyInstance;
  db: DatabaseSync;
  paths: Paths;
  bus: EventEmitter<BusEvents>;
  broadcast(msg: ServerMessage): void;
  invalidate(...topics: Topic[]): void; // debounced 'invalidate' broadcast
  audit(action: string, target: string, diff?: string | null): void;
  // Messages arriving over /ws are routed here. Chat owns subscribe/unsubscribe.
  onClientMessage(handler: (send: (m: ServerMessage) => void, raw: unknown, connId: number) => void): void;
  onClientClose(handler: (connId: number) => void): void;
  // Modules keep the server alive while they work (auto-exit logic in index.ts).
  setBusy(key: string, busy: boolean): void;
  restart?(): void; // set by index.ts: the code on disk starts in a new process, after the current call has answered
}
