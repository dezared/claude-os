// Single contract between server and web. Types only: imported with `import type`.
// Times are epoch ms. Token fields are raw counts. Nullable means "no data": the UI shows an honest empty state.

// ---------- Sessions and projects ----------

export type SessionStatus = 'working' | 'idle' | 'waiting_permission' | 'blocked' | 'ended';
export type SessionOrigin = 'os' | 'external';

export interface Project {
  key: string; // short dir name, suffix on collision, stable once stored
  name: string;
  root: string; // git root (common dir for worktrees) or cwd
  misc: boolean; // parent dirs without a repo: the projects.misc group
  sessionCount: number;
  liveCount: number;
  lastActivity: number | null;
  memoryCount: number;
  memoryConnected: boolean; // autoMemoryDirectory points at the vault
  memoryDrift: number; // new files in the old memory dir of a connected project
  pinned: boolean; // connected by hand: stays listed with no sessions and no notes
  mapPin: boolean | null; // on the star map by hand (true), off it by hand (false), or chosen by last activity (null)
  description: string | null; // what the project is, in the owner's or Claude's words
  color: string | null; // #rrggbb chosen by hand; null: the palette decides
  parent: string | null; // a project key by hand, '' top level by hand, null: the folders decide
  folder: boolean; // only a folder with projects inside: no star of its own, never a parent on the map
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'color' | 'parent' | 'folder'>>;

// GET /api/projects/structure: folders on disk as Claude OS sees them, two levels down.
export interface ProjectStructureNode {
  path: string;
  name: string;
  // project: a listed project's root; inside: folded into `project`; misc: a listed parent of projects;
  // hidden: never a project (the root session's folder, service folders, temp); seen: known, not listed; none: nothing yet
  kind: 'project' | 'inside' | 'misc' | 'hidden' | 'seen' | 'none';
  project?: string;
  reason?: 'git' | 'override' | 'connected'; // why it is or would be a project, or folds into one
  folded?: string[]; // other working folders whose sessions count to this project
  children?: ProjectStructureNode[];
  truncated?: true; // on the root only: the 200-folder cap left some out
}

// What Claude asks the interface to do through the ui_action tool. A new action: one line here, one in UI_ACTION_SET, one case in web/src/lib/uiCommands.ts.
export type UiCommand =
  | { action: 'notify'; kind: 'done' | 'question'; text: string | null }
  | { action: 'toast'; text: string }
  | { action: 'open'; view: UiView; project: string | null };
export type UiView = 'home' | 'projects' | 'sessions' | 'kanban' | 'analytics' | 'tools' | 'settings' | 'planner';
// Records, not arrays: a missing member is a type error. The ui_action tool lists its choices from them.
export const UI_ACTION_SET: Record<UiCommand['action'], true> = { notify: true, toast: true, open: true };
export const UI_VIEW_SET: Record<UiView, true> = { home: true, projects: true, sessions: true, kanban: true, analytics: true, tools: true, settings: true, planner: true };

// The default of a switch over a union: a member without a case is a type error.
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// What "remove from Claude's memory" would touch. The project's source folder is never part of it.
export interface RemovalItem {
  kind: 'journals' | 'vault' | 'state';
  path: string;
  files: number;
  bytes: number;
  skipped: 'shared_dir' | 'inside_source' | null; // left in place, with the reason
}

export interface ProjectRemovalPreview {
  key: string;
  name: string;
  root: string;
  liveCount: number; // above zero: removal is refused
  tabs: number; // Claude OS tabs of this project: they get closed
  items: RemovalItem[];
  claudeJson: { path: string; keys: string[]; safe: boolean; reason: 'live_sessions' | 'unreadable' | null };
  settingsKept: string | null; // settings.local.json in the source folder that still points at the vault
  trash: string; // data/trash: a parent folder, the removal adds <key>-<timestamp>
}

export interface ProjectRemovalResult {
  ok: true;
  trash: string;
  moved: number;
  claudeJson: 'removed' | 'skipped' | 'none';
}

export interface SessionStopResult {
  ok: true;
  how: 'tab' | 'signal';
}

export interface SessionRemovalPreview {
  id: string;
  live: boolean; // removal is refused until it is stopped
  root: boolean; // the root tab's own session: removal is refused
  tabs: number; // Claude OS tabs showing it: they get closed
  items: { kind: 'journal' | 'attachments'; path: string; files: number; bytes: number }[];
  trash: string; // data/trash: a parent folder, the removal adds session-<id>-<timestamp>
}

export interface SessionRemovalResult {
  ok: true;
  trash: string;
  moved: number;
}

export interface SubagentInfo {
  id: string;
  agentType: string | null;
  description: string | null;
  lastActivity: number | null;
  tokens: number; // input + output + cache write
}

export interface SessionInfo {
  id: string;
  project: string | null; // Project.key
  cwd: string;
  kind: string; // interactive | background | sdk...
  origin: SessionOrigin;
  name: string | null;
  title: string | null; // ai-title
  lastPrompt: string | null;
  firstActivity: number | null;
  lastActivity: number | null;
  status: SessionStatus;
  pid: number | null;
  tokens: TokenCounts;
  subagents: SubagentInfo[];
  rootFolder?: boolean; // ran in claudeOS/root: counted as the Claude OS project, tagged "root"
  serviceFolder?: boolean; // ran in claudeOS/service: the hidden service session, in no project and no counter
  osChanges?: { user: number; root: number }; // Edit/Write calls it made in config/ and in server, web, shared, e2e
}

// ---------- Tokens ----------

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number; // shown separately, never part of a total
}

export interface DayTokens extends TokenCounts { day: string; /* YYYY-MM-DD, local */ }
export interface NamedTokens extends TokenCounts { name: string; messages: number; }

export interface Analytics {
  from: string;
  to: string;
  total: TokenCounts;
  main: TokenCounts; // main session
  subagents: TokenCounts;
  osShare: TokenCounts; // sessions started by Claude OS
  bySource: NamedTokens[]; // Claude OS's own load, name is an OsSource; the user's work tabs are not in it
  byDay: DayTokens[]; // every day in the range, zeros included
  byProject: NamedTokens[];
  byModel: NamedTokens[]; // no <synthetic>
  topSessions: (NamedTokens & { sessionId: string; project: string | null })[];
  rateLimits: { sessionId: string; receivedAt: number; raw: unknown }[]; // only Claude OS sessions
  costEquivalentUsd: number | null; // from cost-state, labelled by chat.apiEquivalent
}

export interface IndexStatus {
  filesTotal: number;
  filesDone: number;
  indexing: boolean;
  unknownRecordShare: number; // share of unrecognised records over the recent window
  formatWarning: string | null; // includes the Claude Code version
  formatWarningKey?: string; // the UI's text for formatWarning: errors.<key> with formatWarningParams
  formatWarningParams?: Record<string, string | number>;
  claudeVersion: string | null;
}

// ---------- Memory ----------

export interface MemoryNode {
  id: string; // stable hash of the absolute path
  title: string;
  file: string; // file name
  project: string | null; // Project.key, null for global
  connected: boolean; // lives in the vault; false = read only, other tint
  degree: number;
  live: boolean; // project has an active session
  mtime: number;
  summary: string | null; // frontmatter description or the first meaningful body line; never generated
  issues: string[]; // lint issue codes of a vault note; [] for old-place notes and MEMORY.md
}

// Snippet highlights are control chars, \u0001 opens and \u0002 closes: brackets in note text stay literal.
// id is MemoryNode.id; snippet is at most 160 chars.
export interface MemorySearchHit { id: string; name: string; project: string | null; type: string | null; description: string | null; snippet: string }

export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: [string, string][]; // real [[wikilinks]] only
  unresolved: number;
  vaultPath: string;
  vaultExists: boolean;
  coreProject: string | null; // Project.key of this repository: the centre of the universe, with the global notes
  rootProject?: string | null; // Project.key of the root session's folder: its notes and sessions belong to the core
}

export interface MemoryNote {
  node: MemoryNode;
  path: string;
  markdown: string;
  version: string; // sha256, sent back on save for conflict detection
  obsidianUrl: string | null;
  backlinks: string[];
}

export interface MemoryMigrationPlan { project: string; from: string; to: string; files: string[]; settingsPath: string; settingsDiff: string }

// Wiki migration of one project (spec §4). tokens = ceil(bytes / 4). A dropped item always carries its reason.
export type WikiSize = { lines: number; bytes: number; tokens: number };
export interface WikiPreview { files: { old: string; new: string[]; dropped: { what: string; why: string }[] }[]; warnings: string[]; linkDiff: string; memory: { before: WikiSize; after: WikiSize }; notesAfter: number }
export interface WikiRunView { project: string; run: string; state: 'rewriting' | 'ready' | 'failed' | 'applied' | 'undone'; batches: { n: number; files: string[]; tabId: string | null; status: 'pending' | 'running' | 'ok' | 'failed'; errors: string[]; warnings: string[] }[]; preview: WikiPreview | null }

// ---------- Skills and MCP ----------

export interface Skill {
  id: string; // scope:name
  name: string;
  scope: 'user' | 'project' | 'plugin';
  source: string | null; // plugin or project name
  description: string | null;
  path: string;
  readOnly: boolean;
  disabled: boolean;
  isSymlink: boolean;
  usageCount: number;
  lastUsedAt: number | null;
}

export interface McpServer {
  name: string;
  scope: 'user' | 'project' | 'local' | 'plugin';
  project: string | null;
  transport: string; // stdio | http | sse...
  summary: string; // command or url. env and header VALUES never leave the server
  envKeys: string[];
  health: string | null; // from `claude mcp get`, null until checked
  file?: string; // the config file that holds this definition
}

export interface AuditEntry {
  id: number;
  at: number;
  action: string;
  target: string;
  diff: string | null;
}

// ---------- Actions and widgets ----------

export interface ActionDef {
  id: string;
  title: string;
  command: string;
  cwd: string | null; // supports {project} and {cwd} placeholders
  confirm: boolean;
  builtin: boolean;
  approved: boolean; // sha256 of command is in data/approved-commands.json
}

// What the terminal button runs for a session right now. holder: who runs that session, null when nobody does.
export interface TerminalPreview {
  command: string;
  fork: boolean;
  holder: 'tab' | 'terminal' | null;
}

// One line of the /btw stream.
// What a session tells Claude when a request of its is denied without the user's words. The UI shows errors.<key> for them.
export const DENY_TEXTS = {
  denyInterrupted: 'Interrupted by the user',
  denyRefused: 'The user denied it',
  denyPlan: 'The user rejected the plan',
  denyTabClosed: 'The tab was closed',
  denyTurnEnded: 'The turn ended',
  denyCancelled: 'The request was cancelled',
} as const;

export type BtwEvent = { text: string } | ({ done: true; error: string | null } & MessageKey);

// The UI shows `errors.<key>` from its catalog with `params`; the English text next to it is the fallback and what logs and Claude get.
export interface MessageKey { key?: string; params?: Record<string, string | number> }

// A place on the home screen. The centre stays clear for the map and the input.
export const HOME_SLOTS = ['left', 'right', 'top', 'bottom-left', 'bottom-right'] as const;
export type HomeSlot = (typeof HOME_SLOTS)[number];

// config/settings.json, key "home": what stands in each slot, top to bottom. Holds the built-in panels and the blocks by id.
// hidden is the trash: off the screen, keeps its place, listed in Settings. removed: built-ins deleted for good, they have no entry to delete.
export interface HomeLayout {
  slots: Partial<Record<HomeSlot, string[]>>;
  hidden: string[];
  collapsed?: string[];
  heights?: Record<string, number>; // built-ins only: a block keeps its height in its own entry
  removed?: string[];
}

// Free placement in window pixels, from before the slots: read once to find the nearest slot, dropped on the first move.
export interface WidgetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A button under a widget: a new tab in cwd that starts with prompt. With readyWhen it is pressable only while the widget's value contains that text.
export interface WidgetAction {
  label: string;
  cwd: string;
  prompt: string;
  readyWhen?: string;
}

// A widget's own view: config/widgets/<file>, a module whose activate(host) returns the React component that draws the value.
// It runs in the interface, so only once approved, by the hash of its text: a changed file waits for approval again.
export interface WidgetView {
  file: string;
  sha: string | null; // null: the file is missing
  approved: boolean;
}

// A widget with neither slot nor box stays off the screen. Height in pixels, by content when absent; the width is the slot's.
// icon: a Lucide name, iconSvg: its drawing from the library (absent for an unknown name); description: what the widget shows, Markdown, at most 500 characters.
export type WidgetDef = { slot?: HomeSlot; height?: number; box?: WidgetBox; action?: WidgetAction; view?: WidgetView; icon?: string; iconSvg?: string; description?: string } & (
  | { id: string; title: string; type: 'command'; command: string; intervalSec: number; approved: boolean }
  | { id: string; title: string; type: 'file'; path: string; pointer?: string; approved: true }
  | { id: string; title: string; type: 'note'; noteId: string; approved: true }
  | { id: string; title: string; type: 'block'; content?: string; approved: true }
);

export interface WidgetValue {
  id: string;
  value: string | null;
  updatedAt: number | null;
  error: string | null;
}

// ---------- Overview (bottom strip of the home screen) ----------

export interface Overview {
  claudeVersion: string | null;
  skills: number;
  plugins: number;
  hooks: number;
  mcpServers: number;
  apiConnected: false; // the second engine is out of MVP
  recentNotes: { id: string; title: string; mtime: number }[];
  index: IndexStatus;
}

// ---------- Tabs and chat ----------

// The row of Analytics.byProject holding the hidden service session's tokens: they are spent, and on no project.
export const SERVICE_TOKENS_NAME = 'Claude OS service';

export type TaskState = 'working' | 'waiting' | 'done' | 'failed';

// What a tab said through report_progress. `state` is checked against the tab itself: see TabSession.taskState.
export interface TabProgress {
  percent: number; // 0-100
  step: string | null;
  state: TaskState;
  at: number;
}

export interface Tab {
  id: string;
  kind: 'root' | 'work' | 'readonly' | 'service' | 'document'; // service never leaves the server: see Chat.list
  document?: string | null; // kind 'document': the id of what it shows beside its chat
  project: string | null;
  cwd: string;
  sessionId: string | null;
  title: string;
  order: number;
  model: string | null;
  effort: string | null;
  worktree: boolean;
  status: SessionStatus;
  attention: boolean; // waiting for permission or an answer
  queued: number;
  permissionMode?: string | null; // the last mode Claude reported or the user chose; null: the CLI decides at start
  progress?: TabProgress | null; // absent: this tab never reported, it is not on the home widget
}

// ---------- Documents ----------

export const DOCUMENT_KINDS = ['report', 'documentation', 'plan', 'dashboard', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DocumentInfo {
  id: string;
  title: string;
  project: string | null; // Project.key, null: not about one project
  knowledge: string; // the knowledge file it was built from
  kind: DocumentKind; // taken from the knowledge file
  summary: string;
  created: number;
  updated: number;
  version: number;
  size: number; // bytes of HTML
  shared: { url: string; at: number } | null; // the link once it has been exported to claude.ai
  snippet?: string; // only in search results
}

export interface DocumentKnowledgeInfo {
  id: string;
  name: string;
  nameRu: string | null; // `name_ru` in the frontmatter: what the ru UI shows
  kind: DocumentKind;
  description: string;
  descriptionRu: string | null; // `description_ru`
  builtin: boolean; // ships with Claude OS
  customized: boolean; // a user's file stands over it, or there is nothing else
  path: string;
  documents: number;
}

export interface DocumentKnowledge extends DocumentKnowledgeInfo {
  text: string; // the whole file, frontmatter included
}

export interface AppStatus {
  stale: boolean; // the server's code on disk is newer than the running process
  busy: boolean; // a restart would stop running work
  repo: string;
}

export interface NewTabRequest {
  project?: string; // Project.key
  cwd?: string;
  title?: string;
  worktree?: boolean;
  model?: string;
  effort?: string;
  resumeSessionId?: string; // work.continueHere and read-only sessions
  readonly?: boolean;
  source?: OsSource; // Claude OS opens it for itself: its tokens count as Claude OS's own load
  sourceDetail?: string; // which widget, microtask...
}

// What spent the tokens of a session Claude OS started for itself. Root, service and setup also follow from the cwd.
export const OS_SOURCES = ['root', 'service', 'microtask', 'widget', 'crash-fix', 'ask', 'setup'] as const;
export type OsSource = typeof OS_SOURCES[number];

export interface Attachment { name: string; mediaType: string; base64: string; }

export interface SendRequest { text: string; attachments?: Attachment[]; }

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; subagent?: string | null }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { type: 'image'; mediaType: string; base64: string };

export interface QueuedMessage { id: string; blocks: ChatBlock[]; }

// A subagent or a background command of a running Claude OS session, from the SDK's task events.
export interface TaskInfo {
  id: string;
  toolUseId: string | null;
  type: string | null; // local_agent, local_bash...
  description: string;
  agentType: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  tokens: number | null;
  toolUses: number | null;
  lastTool: string | null;
}

export interface SubagentTranscript {
  id: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  lastActivity: number | null;
  finished: boolean; // the CLI marked its meta file; false also for a subagent that died without a mark
  events: ChatEvent[];
}

// A subagent at work now, from its journal: no status exists there, so a fresh file without a mark of the end counts.
export interface ActiveSubagent {
  id: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  startedAt: number;
  lastActivity: number;
  doing: string | null; // the latest tool call: "Bash npm test"
}

// `seq` is per tab and strictly increasing: the client reconnects with the last seq it saw.
export type ChatEvent = { seq: number; at: number } & (
  // queued:true = waiting behind a running turn; the same message comes again with queued:false when it starts.
  // An interrupt cancels the queue: a 'warning' carries the texts, and no queued:false follows.
  | { e: 'user'; blocks: ChatBlock[]; queued?: boolean; queueId?: string }
  | { e: 'queue'; items: QueuedMessage[] } // the whole queue after an edit, a removal or a delivery into the running turn
  | { e: 'mode'; mode: string | null }
  | { e: 'task'; task: TaskInfo }
  // The same messageId means "append blocks".
  | ({ e: 'assistant'; messageId: string; blocks: ChatBlock[]; model: string | null } & MessageKey)
  | { e: 'delta'; messageId: string; text: string } // streaming text, replaced by 'assistant'
  | { e: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { e: 'init'; sessionId: string; model: string | null; slashCommands: SlashCommand[]; permissionMode: string | null }
  | { e: 'status'; status: SessionStatus }
  | { e: 'permission'; requestId: string; tool: string; input: unknown; diff: string | null; title: string | null }
  | { e: 'question'; requestId: string; questions: unknown } // AskUserQuestion
  | { e: 'plan'; requestId: string; plan: string } // ExitPlanMode
  | { e: 'resolved'; requestId: string; decision: string }
  // usage is per turn; costUsd is the session's running total, never to be summed.
  | ({ e: 'result'; usage: TokenCounts; costUsd: number | null; interrupted: boolean; error: string | null } & MessageKey)
  | { e: 'interrupted' } // turn cut off by a server restart
  | { e: 'cleared' } // /clear or the panel's reset: everything before this event is gone
  // A command that exists only as a terminal screen, run in a background pseudo-terminal. The same runId replaces the screen.
  | ({ e: 'terminal'; runId: string; command: string; screen: string; done: boolean; error: string | null; runs?: TerminalRun[] } & MessageKey) // the key is the error's
  | ({ e: 'warning'; text: string } & MessageKey)
  | ({ e: 'error'; text: string } & MessageKey)
);

/** A stretch of one line of a terminal screen in the colours the CLI drew it: a palette number or #rrggbb. Absent means the terminal's default. */
export interface TerminalRun { line: number; from: number; to: number; fg?: number | string; bg?: number | string; bold?: true; dim?: true; inverse?: true; }

export interface SlashCommand { name: string; needsTerminal: boolean; }

// What the `/` menu shows. `name` has no leading slash.
export interface CommandInfo extends SlashCommand {
  description: string | null;
  argumentHint: string | null;
  source: 'builtin' | 'skill' | 'plugin' | 'project';
}

export type RespondRequest =
  | { kind: 'permission'; allow: boolean; message?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'plan'; approve: boolean; message?: string };

// ---------- Account and limits ----------

export interface LimitWindow {
  kind: string; // the server's meter kind: session, weekly_all, weekly_scoped...
  label: string | null; // the server's scope label, a model name for example
  percent: number | null;
  resetsAt: number | null;
  severity: string | null;
  active: boolean; // the row a single-value indicator shows
}

export interface AccountStatus {
  plan: string | null; // as given by the source, not mapped
  planSource: 'cli' | 'claude_json' | null;
  billing: 'subscription' | 'api' | 'unknown'; // dollars appear in the UI only for 'api'
  windows: LimitWindow[];
  source: 'usage' | 'cache' | 'events' | 'none'; // usage: the CLI's /usage data, cache: ~/.claude.json, events: rate_limit_event of Claude OS sessions
  receivedAt: number | null;
  error: string | null;
  events: { type: string; status: string | null; utilization: number | null; resetsAt: number | null; receivedAt: number }[];
}

// ---------- Settings, IDEs ----------

export type IdeFamily = 'vscode' | 'jetbrains' | 'visualstudio' | 'plain';

export interface IdeEntry {
  id: string; // <catalogId>-<hash of exe>, stable
  catalogId: string; // phpstorm, vscode...
  name: string;
  family: IdeFamily;
  exe: string; // Windows path or Linux path
  side: 'windows' | 'linux';
  source: string; // path, app_paths, uninstall, vswhere, toolbox, known, manual
  approved: boolean; // every scan result is; an entry someone else wrote into the config waits for a click
}

export interface ProjectSettings {
  model?: string | null;
  effort?: string | null;
  ide?: string | null; // IdeEntry.id; absent means the automatic choice
}

export interface SettingsView {
  platform: 'wsl' | 'windows' | 'linux' | 'mac';
  ides: IdeEntry[];
  scannedAt: number | null;
  scanning: boolean;
  scanError: string | null;
  obsidian: { installed: boolean | null; exe: string | null; dismissed: boolean; vaultWindows: string }; // the vault as the app would open it
  projects: Record<string, ProjectSettings>;
  universe: UniverseOptions;
  home: HomeLayout;
  profile: Profile | null; // null: setup has not asked yet
  setup: SetupState;
}

export type QuestionLevel = 'minimal' | 'balanced' | 'thorough';

// config/settings.json, key "profile": who the user is, for the prompts and the new project folder.
export interface Profile {
  name: string;
  language: string; // ISO 639 code: the reply language and the UI language
  projectsDir: string; // absolute; create_project makes new projects here
  questionLevel: QuestionLevel;
}

// config/settings.json, key "setup": the first-run setup.
export interface SetupState {
  step: 'checks' | 'onboarding' | 'done';
  completedAt: number | null;
  tabId: string | null;
}

// GET /api/setup/checks: deterministic, no prompt sent. The fix text for each id is in the web catalogs as setup.fix.<id>.
export type SetupCheckId = 'claude-binary' | 'claude-version' | 'login' | 'plan' | 'limits' | 'node' | 'git' | 'projects-dir';

export interface SetupCheck {
  id: SetupCheckId;
  status: 'ok' | 'warn' | 'fail'; // any fail blocks the onboarding step
  detail: string | null; // what was found: a version, a path. 'unknown': not checked, an earlier check failed; 'unreadable': claude --version said nothing usable
  limit?: { percent: number | null; resetsAt: number | null }; // id 'limits' only: the window or rate-limit event behind a warning, resetsAt in ms
}

export type UniverseTheme = 'default' | 'ember' | 'aurora' | 'mono';

// The map's look and how many projects it holds. config/settings.json, key "universe": Claude can edit it too.
export interface UniverseOptions {
  limit: number; // projects on the map; over it, the most recently active stay
  theme: UniverseTheme;
  colors: { bg?: string; inner?: string; outer?: string }; // #rrggbb over the theme: sky, dust near the centre, dust at the rim
  crossLinks: boolean; // light up links between notes of different projects
  nesting: boolean; // show which projects live inside another project's folder
}

export interface ProjectIde {
  chosen: IdeEntry | null;
  auto: boolean; // chosen by the marker files, not by the user
  marker: string | null; // the file that decided it
  others: IdeEntry[];
}

// ---------- Git ----------

export interface GitFile { path: string; oldPath: string | null; status: string; /* A M D R C T U ? */ }

export interface GitCommit { hash: string; short: string; subject: string; author: string; at: number; }

export type GitStatus =
  | { isRepo: false; reason: 'not_a_repo' | 'git_missing' }
  | {
    isRepo: true;
    root: string;
    branch: string | null; // null: detached HEAD
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    staged: GitFile[];
    unstaged: GitFile[];
    untracked: GitFile[];
    truncated: boolean; // the file lists were capped
    commits: GitCommit[];
    lastFetch: number | null;
  };

export interface GitDiff {
  path: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitPushPreview {
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  remoteBranch: string | null;
  ahead: number;
  behind: number;
  commits: GitCommit[];
  remotes: string[];
}

export interface GitBranch {
  name: string; // local: feature/x; remote: origin/feature/x
  kind: 'local' | 'remote';
  current: boolean;
  short: string;
  at: number;
  subject: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean; // the upstream was deleted on the remote
}

export interface GitBranches {
  current: string | null;
  recent: string[];
  local: GitBranch[];
  remote: GitBranch[];
  truncated: boolean;
}

export interface GitCompare {
  ref: string;
  incoming: GitCommit[]; // in ref, not in HEAD
  outgoing: GitCommit[]; // in HEAD, not in ref
  files: GitFile[];
}

export interface GitRefLabel { name: string; kind: 'head' | 'local' | 'remote' | 'tag'; }

export interface GitLogCommit extends GitCommit { parents: string[]; refs: GitRefLabel[]; }

export interface GitLog { commits: GitLogCommit[]; more: boolean; }

export interface GitStash { ref: string; subject: string; at: number; }

export interface GitAmendInfo { message: string; pushed: boolean; }

// ---------- Usage log: what sessions read from skills and memory ----------

export interface UsageEntry {
  id: number;
  session: string;
  project: string | null;
  tool: string; // Skill, Read, Edit, Write, Grep...
  target: string; // skill name or file path
  kind: 'skill' | 'vault' | 'external'; // external: ~/.claude/projects/*/memory
  op: 'use' | 'read' | 'write';
  at: number | null;
}

export interface UsageTotals { reads: number; writes: number; last: number | null; }

// ---------- Vault ----------

export interface VaultCopyPreview {
  project: string;
  name: string;
  to: string;
  sources: string[];
  newFiles: string[];
  existing: number; // already there, same content
  conflicts: string[]; // already there with other content: the vault copy stays
}

export interface VaultStatus {
  path: string;
  exists: boolean;
  projects: VaultCopyPreview[];
}

// ---------- CLAUDE.md ----------

export interface ClaudeMdFile {
  scope: 'global' | 'root' | 'project';
  path: string;
  exists: boolean;
  content: string;
  version: string; // sha256 of the content, sent back on save for conflict detection
  updatedAt: number | null;
}

export interface ClaudeMdReport {
  files: ClaudeMdFile[];
}

// ---------- Admin panels: read only, from config files and journals ----------

export interface AdminProjectDiff {
  project: string | null; // Project.key; null: a folder only ~/.claude.json knows
  name: string;
  root: string;
  own: string[]; // defined only here
  overrides: string[]; // also defined globally, differently
}

export interface AdminStat { name: string; n: number; }

export interface SkillAdminRow extends Skill {
  runs: number; // in the window, from the journals
  runsAll: number; // every run the journals hold
}

export interface SkillsReport {
  windowDays: number;
  journalSince: number | null; // the journals say nothing about earlier use
  rows: SkillAdminRow[];
  byDay: { day: string; runs: number }[];
  gone: { name: string; runs: number; last: number | null }[]; // run in the window, no longer installed
  projects: (AdminProjectDiff & { runs: number })[];
}

export type McpConnection = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'not-loaded' | 'unchecked';

export interface McpToolInfo {
  name: string;
  description: string | null;
  readOnly: boolean;
  destructive: boolean;
}

export interface McpProbe {
  at: number;
  error: string | null; // the probe itself failed, the statuses are older
}

export interface McpAdminRow {
  name: string;
  where: { global: boolean; projects: { key: string | null; name: string }[]; plugin: string | null; account: boolean }; // account: a claude.ai connector
  definitions: McpServer[]; // one per scope and project; empty for a claude.ai connector
  status: McpConnection; // the worst of the checked places
  statusBy: { place: string; status: McpConnection; error: string | null }[];
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: McpToolInfo[]; // as reported by the status answer, without descriptions on some CLI versions
  description: string | null; // the plugin manifest, when a plugin ships it
  note: string | null; // the user's own words, config/settings.json `mcpNotes`
  calls: number; // in the window, from the journals
  toolsUsed: number;
  lastCall: number | null;
}

export interface McpReport {
  windowDays: number;
  journalSince: number | null;
  rows: McpAdminRow[];
  gone: { name: string; calls: number; last: number | null }[]; // in the journals, in no config now
  probes: Record<string, McpProbe>; // by place: 'global' or a project key
  probing: boolean;
  projects: AdminProjectDiff[];
}

// What the server itself says, from a short handshake. Never contains env or header values.
export interface McpServerDetails {
  name: string;
  available: boolean;
  reason: 'needs_login' | 'not_connected' | 'unsupported' | 'error' | null;
  instructions: string | null;
  tools: McpToolInfo[];
}

export interface HookAdminRow {
  scope: 'user' | 'project' | 'local' | 'plugin';
  project: string | null;
  plugin: string | null;
  event: string;
  matcher: string | null;
  type: string; // command, prompt...
  summary: string; // masked
  file: string;
  changedAt?: number | null; // when that file last changed, not the hook itself
}

export interface HooksReport {
  rows: HookAdminRow[];
  projects: AdminProjectDiff[];
}

export interface PluginAdminRow {
  id: string; // name@marketplace
  name: string;
  marketplace: string | null;
  description: string | null;
  version: string | null;
  enabled: boolean; // enabled globally
  scopes: string[];
  projects: { key: string | null; name: string }[];
  installedAt: number | null;
  updatedAt: number | null;
  skills: number;
  skillsUsed: number; // run at least once in the window
  runs: number;
  mcp: number;
  hooks: number;
  agents: number;
  commands: number;
  latest: string | null; // from the local marketplace copy; null: not known
  update: boolean | null; // null: not knowable from local data
  marketplaceAt: number | null; // when that local copy was refreshed
  author?: string | null; // from the plugin manifest
  homepage?: string | null;
  license?: string | null;
}

export interface PluginsReport {
  windowDays: number;
  rows: PluginAdminRow[];
  projects: AdminProjectDiff[];
}

// What the page of a skill, MCP server or project adds to its report row. What is not known stays null or empty.
export interface EntityStats {
  windowDays: number;
  journalSince: number | null;
  total: number; // everything the journals hold: runs, calls, or tokens for a project
  recent: number; // in the window
  last: number | null;
  byDay: { day: string; n: number }[]; // every day of the window
  byProject: { key: string | null; name: string; n: number }[]; // in the window
  byName: { name: string; n: number }[]; // in the window: MCP tools, or the tools a project's sessions called
  byModel: { name: string; n: number }[]; // project only: tokens in the window
  createdAt: number | null; // the file's birth, or a project's first session
  changedAt: number | null; // the file's last change
  meta: Record<string, string>; // author, version, license... as the skill's frontmatter states them
  history: { at: number; action: string }[]; // what went through Claude OS itself, newest first
}

// An estimate: straight extrapolation over the recent days.
export interface Forecast {
  basisDays: number;
  activeDays: number;
  dailyAverage: number; // tokens per calendar day over the basis, today excluded
  today: number;
  todayHours: number[]; // 24 local hours
  todayProjected: number;
  weekProjected: number;
  monthProjected: number; // 30 days
  windows: {
    kind: string;
    label: string | null;
    percent: number;
    resetsAt: number;
    projected: number | null; // percent at the reset; null: the window has only just started
    hitsAt: number | null; // when the pace reaches 100%, before the reset
  }[];
}

export const LIBRARY_ICON_INK = '#e4e4e7'; // the colour library icons are served in; a UI may paint its own over it

export interface ProjectIcons {
  dir: string; // where the icons live: icons.json holds library names, <key>.svg a custom icon
  icons: Record<string, string>; // Project.key -> sanitized SVG
  chosen: Record<string, string>; // Project.key -> library name ('map', 'si:gitlab'); wins over a custom SVG
  rejected: { key: string; reason: string }[];
  offerDismissed: boolean;
}

export interface IconLibrary {
  total: number; // matches, of which `items` is the first page
  items: { name: string; svg: string }[];
}

// ---------- Claude OS plugins: packages in config/plugins, kept apart from Claude's own plugins ----------

export interface OsPluginContents {
  skills: string[];
  hooks: { event: string; matcher: string | null; command: string }[];
  mcp: { name: string; summary: string; envKeys: string[] }[];
  ui: { entry: string; permissions: OsPluginPermission[] } | null;
  kit: string | null; // the folder of project kit templates; enabling it installs nothing globally
}

export const OS_PLUGIN_COMPONENTS = ['skills', 'hooks', 'mcp', 'ui', 'kit'] as const;
export const OS_PLUGIN_PERMISSIONS = ['files.write', 'files.reveal', 'files.media'] as const;
export type OsPluginPermission = (typeof OS_PLUGIN_PERMISSIONS)[number];

// What a plugin needs from outside its folder. The server only looks; Claude does the work, in a tab, after the user agrees.
export const OS_PLUGIN_DEPENDENCY_KINDS = ['config', 'service', 'package', 'download'] as const;
export type OsPluginDependencyKind = (typeof OS_PLUGIN_DEPENDENCY_KINDS)[number];

export interface OsPluginDependency {
  id: string;
  kind: OsPluginDependencyKind; // config: lines in a file of Claude's; service: an address that answers; package: a program on PATH; download: a file on disk
  level: 'required' | 'recommended'; // neither blocks enabling: Claude can only set it up afterwards
  title: string;
  titleRu: string | null;
  why: string;
  whyRu: string | null;
  target: string; // the file, address, program or path it is about
  block: string | null; // config: the exact lines, with their markers
  state: 'met' | 'missing' | 'unknown'; // unknown: there is nothing the server can safely look at
}

/** The request to Claude that sets up what is missing: the same text is shown before it goes. */
export interface OsPluginSetup {
  cwd: string;
  title: string;
  prompt: string;
}

/** An enabled plugin's interface code, unchanged since it was reviewed. */
export interface OsPluginUi {
  id: string;
  name: string;
  url: string;
}

export interface OsPluginRow {
  id: string;
  name: string;
  description: string | null;
  descriptionRu: string | null;
  features: string[]; // what it gives, one line each
  featuresRu: string[];
  icon: string | null; // a checked SVG, drawn through an img
  version: string | null;
  author: string | null;
  path: string;
  source: 'shipped' | 'user'; // plugins/ or config/plugins; a user copy hides the shipped one with the same id
  contains: OsPluginContents;
  dependencies: OsPluginDependency[];
  setup: OsPluginSetup | null; // null: nothing is known to be missing
  errors: string[]; // a plugin with errors cannot be enabled
  enabled: boolean;
  installedVersion: string | null;
  installedAt: number | null;
  changed: boolean; // the folder differs from what was enabled
}

export interface OsPluginsReport {
  dir: string;
  rows: OsPluginRow[];
}

export interface OsPluginChange {
  kind: 'skill' | 'hook' | 'mcp' | 'ui' | 'config' | 'kit';
  action: 'add' | 'remove' | 'keep' | 'gone'; // keep: changed since it was enabled, so it is not ours to delete
  name: string;
  where: string;
  detail: string;
}

export interface OsPluginPlan {
  id: string;
  action: 'enable' | 'disable' | 'update'; // update: what is there goes, the folder as it is now comes in
  version: string | null;
  changes: OsPluginChange[];
  dependencies: OsPluginDependency[];
  setup: OsPluginSetup | null;
  conflicts: string[];
  sha: string; // sent back on confirm: what was reviewed is what gets applied
}

// ---------- Microtasks: a ready prompt for a chosen session ----------

export interface Microtask {
  id: string;
  title: string;
  titleRu: string;
  input: string | null; // name of the free-text variable, if the template asks for one
  prompt: string; // with {variables}
}

// ---------- Planner notes ----------

export interface PlannerNote {
  id: string;
  path: string; // absolute: what a chat mention inserts
  title: string;
  text: string;
  created: string; // ISO
  filed: boolean; // false: still in the inbox
  topic: string | null;
  date: string | null; // YYYY-MM-DD
  version: string; // of the text: filing moves the file and keeps this, an edit changes it
  job?: PlannerJob; // only in /api/planner, and only until the server restarts: the note itself stays where it was
  folder?: string | null; // PlannerFolder.id, only in /api/planner
}

// The palette new folders take from and the picker offers first.
export const FOLDER_COLORS = ['#e07a5f', '#e0a458', '#a3b565', '#5fb49c', '#5fa8d3', '#8e8cd8', '#c77dba', '#9aa0a6'] as const;

export interface PlannerFolder {
  id: string;
  name: string;
  color: string; // #rrggbb: a new folder gets one of FOLDER_COLORS, the owner may pick any
}

// What a restart or a reboot cut off. Nothing here goes on by itself: going on spends tokens.
export type RecoveryItem =
  | { kind: 'tab'; tabId: string; tabKind: Tab['kind']; title: string; project: string | null; sessionId: string | null; interruptedAt: number | null; queued: { id: string; text: string; attachments: number }[] }
  | { kind: 'session'; sessionId: string; title: string; project: string | null; cwd: string; lastActivity: number | null }; // ran in a plain terminal

export interface PlannerJob {
  state: 'queued' | 'running' | 'failed';
  error?: string;
}

// ---------- Project files of a work tab ----------

export interface FileEntry {
  name: string;
  path: string; // relative to the tab's cwd
  dir: boolean;
  size: number | null;
}

export interface ProjectFile {
  path: string;
  size: number;
  kind: 'text' | 'binary';
  text: string | null; // null: binary
  truncated: boolean; // only the beginning of a large file
  sha: string | null; // what a save has to name; null: this file cannot be edited in place
}

// ---------- Project setup panel ----------

export interface SetupFile {
  scope: 'project' | 'local';
  path: string;
  exists: boolean;
  text: string; // secret values masked; a masked value stays as it was on save
  keys: string[];
  invalid: boolean;
}

export interface SetupHook {
  scope: 'project' | 'local';
  event: string;
  matcher: string | null;
  index: number; // position inside the event's list
  summary: string; // commands, masked
}

export interface ProjectSetup {
  key: string;
  root: string;
  settings: SetupFile[];
  hooks: SetupHook[];
  mcp: McpServer[];
  skills: Skill[];
}

export type PromoteRequest =
  | { kind: 'skill'; name: string }
  | { kind: 'mcp'; name: string; scope: 'project' | 'local' }
  | { kind: 'hook'; scope: 'project' | 'local'; event: string; index: number }
  | { kind: 'key'; scope: 'project' | 'local'; key: string };

export interface PromotePreview {
  title: string;
  files: { path: string; diff: string }[];
  conflict: string | null; // refuses when set
}

// ---------- WebSocket: GET /ws ----------

export type ClientMessage =
  | { t: 'subscribe'; tabId: string; lastSeq: number }
  | { t: 'unsubscribe'; tabId: string };

export interface VoiceStatus {
  state: 'off' | 'downloading' | 'ready';
  model: string;
  modelBytes: number; // download size of the model
  diskBytes: number; // what is really in `dir` now
  downloaded: number | null; // while downloading
  dir: string;
  error: string | null;
}

// ---------- Claude's agents ----------

export interface AgentRow {
  id: string; // user:<name>, project:<source>:<name>, plugin:<plugin>:<name>
  name: string;
  scope: 'user' | 'project' | 'plugin';
  source: string | null; // Project key or plugin name
  description: string | null;
  model: string | null; // as the file states it; absent: inherits
  tools: string[] | null; // as the file states them; absent: all
  path: string;
  readOnly: boolean;
  isSymlink: boolean;
  runs: number; // subagent journals of this type, in the window
  runsAll: number;
  tokens: number; // input + output + cache write of those runs, in the window
  lastUsedAt: number | null;
}

export interface AgentsReport {
  windowDays: number;
  journalSince: number | null;
  rows: AgentRow[];
  byDay: { day: string; runs: number }[];
  other: { name: string; runs: number; runsAll: number; last: number | null }[]; // ran, no file here: built-in or deleted
  untyped: number; // subagent journals without a type in their meta file: counted nowhere above
  projects: AdminProjectDiff[];
}

export interface AgentDetail {
  agent: AgentRow;
  content: string;
  stats: EntityStats;
  recent: { session: string; project: string | null; description: string | null; at: number | null; tokens: number }[];
}

// ---------- Kanban ----------

export const KANBAN_COLUMNS = ['backlog', 'todo', 'doing', 'polish', 'done'] as const; // in the order of the board
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];
export type KanbanPriority = 'low' | 'normal' | 'high';
export type KanbanLevel = 'user' | 'root'; // the levels of a session's osChanges: config/, or server, web, shared, e2e

export interface KanbanCard {
  id: string; // like OS-21: the project's prefix and a number, and the name of the card's file
  path: string; // the card's .md file in the vault: can be edited directly and mentioned with @
  agent?: string; // who took the task
  agentTab?: string; // the tab it works in, when it is one
  title: string;
  description: string;
  project: string | null; // Project.key; null: not about one project
  priority: KanbanPriority;
  column: KanbanColumn;
  level?: KanbanLevel; // what the task changes in Claude OS: only on cards of that project
  sprint?: string; // KanbanSprint.id; absent, or an id the board does not know: no sprint
  sessions?: string[]; // sessions of the tabs that took it, oldest first, the last 20
  created: number;
  updated: number;
}

// A third dimension over the same five columns, kept in _board.json.
export interface KanbanSprint {
  id: string; // like S3
  name: string;
}

export interface KanbanCardSessions {
  live: Tab | null; // the tab working on the card now
  ended: SessionInfo[]; // its last sessions that no tab holds, newest first, up to 3
}

export type { ServiceTask, ServiceTaskStatus } from './serviceTask.ts';

export type Topic =
  | 'sessions' | 'projects' | 'tokens' | 'memory' | 'skills' | 'mcp'
  | 'actions' | 'widgets' | 'tabs' | 'overview' | 'audit' | 'settings' | 'account' | 'osPlugins' | 'usage' | 'planner' | 'voice' | 'agents' | 'kanban' | 'service' | 'documents' | 'projectKit';

export type ServerMessage =
  | { t: 'chat'; tabId: string; event: ChatEvent }
  | { t: 'invalidate'; topics: Topic[] } // the client refetches the matching REST data
  | { t: 'widget'; value: WidgetValue }
  | { t: 'ui'; tabId: string; command: UiCommand } // a session asks the interface to do something
  | { t: 'tab_opened'; tab: Tab; focus: boolean }; // root session opened a tab

// ---------- REST, all under /api, JSON. Errors: { error: string } with a 4xx/5xx status ----------
//
// journal (server/journal)
//   GET  /api/projects                      -> Project[]
//   GET  /api/sessions?project=&live=1      -> SessionInfo[]
//   GET  /api/sessions/:id/transcript       -> ChatEvent[]  (read only view, seq from 1)
//   POST /api/sessions/:id/stop             -> SessionStopResult (409 { error, code: 'ended' | 'no_pid' })
//   GET  /api/sessions/:id/removal          -> SessionRemovalPreview
//   POST /api/sessions/:id/remove           { confirm: id } -> SessionRemovalResult (409 code 'live', 403 code 'root')
//   GET  /api/projects/:key/removal         -> ProjectRemovalPreview
//   POST /api/projects/:key/remove {confirm: project name} -> ProjectRemovalResult (409 with live sessions, moves to data/trash)
//   POST /api/projects/connect {path}       -> Project  (pinned)
//   POST /api/projects/:key/map {on: boolean | null} -> Project  (on, off or back to automatic)
//   GET  /api/fs/dirs?path=                 -> string[]  (directory completion, absolute paths)
//   GET  /api/analytics?from=&to=           -> Analytics    (default: last 30 days)
//   GET  /api/analytics/kit?from=&to=       -> KitMetricsRow[]  (server/tools/kitMetrics.ts; projects with .claude/kit/lock.json)
//   GET  /api/index                         -> IndexStatus
//   GET  /api/overview                      -> Overview
//   GET  /api/audit                         -> AuditEntry[]
//
// chat (server/chat)
//   GET    /api/tabs                        -> Tab[]
//   POST   /api/tabs            NewTabRequest -> Tab
//   PATCH  /api/tabs/:id       {title?,order?,model?,effort?,permissionMode?} -> Tab
//   PATCH  /api/tabs/:id/queue/:queueId {text} -> { ok: true }  (404 once Claude has it)
//   DELETE /api/tabs/:id/queue/:queueId     -> { ok: true }
//   POST   /api/tabs/:id/queue/:queueId/send -> { ok: true }  (into the running turn)
//   GET    /api/sessions/:id/subagents -> ActiveSubagent[]
//   GET    /api/sessions/:id/subagents/:key -> SubagentTranscript  (key: agent id or the spawning tool_use id)
//   GET    /api/tabs/:id/image?path=        -> image bytes  (tab's cwd or a known project; only real images, by content)
//   DELETE /api/tabs/:id                    -> { ok: true }  (root tab cannot be closed)
//   GET    /api/tabs/:id/history            -> ChatEvent[]
//   POST   /api/tabs/:id/send   SendRequest -> { ok: true }
//   POST   /api/tabs/:id/interrupt          -> { ok: true }
//   DELETE /api/tabs/:id/progress           -> { ok: true }  (off the home widget until it reports again)
//   POST   /api/tabs/:id/respond/:requestId RespondRequest -> { ok: true }
//   GET    /api/tabs/:id/files?q=           -> string[]  (@-mention completion)
//   GET    /api/models                      -> { id: string; label: string }[]
//
// memory (server/memory)
//   GET  /api/memory/graph                  -> MemoryGraph
//   GET  /api/memory/notes/:id              -> MemoryNote
//   PUT  /api/memory/notes/:id  {markdown,version} -> MemoryNote (409 on conflict, read only: 403)
//   GET  /api/memory/migrate/:project       -> MemoryMigrationPlan
//   POST /api/memory/migrate/:project       -> { ok: true; copied: number; skipped: string[] }
//   GET  /api/memory/search?q=&limit=&project= -> MemorySearchHit[]  (limit default 20, max 20)
//   POST /api/memory/wiki/:project/prepare  -> WikiRunView (409: a run in progress, or 4 projects rewriting)
//   GET  /api/memory/wiki/:project          -> WikiRunView | null
//   POST /api/memory/wiki/:project/verify   -> WikiRunView (verify the started batches again, from disk)
//   POST /api/memory/wiki/:project/apply  {connect: boolean} -> WikiRunView (ready only; 409 lists changed inputs)
//   POST /api/memory/wiki/:project/undo     -> { restored: string[]; kept: string[]; conflicts: string[] }
//   DELETE /api/memory/wiki/:project        -> { ok: true } (discards a run before apply)
//
// tools (server/tools)
//   GET    /api/skills                      -> Skill[]
//   GET    /api/skills/:id                  -> { skill: Skill; content: string }
//   POST   /api/skills/preview  {id?,name?,content} -> { diff: string }
//   POST   /api/skills          {name,content} -> Skill
//   PUT    /api/skills/:id      {content}   -> Skill   (backup, audit)
//   POST   /api/skills/:id/toggle           -> Skill   (moves to ~/.claude/skills-disabled)
//   GET    /api/mcp                         -> McpServer[]
//   POST   /api/mcp/:name/check {scope?,project?} -> McpServer
//   POST   /api/mcp    {name,scope,json,confirmed:true,project?} -> McpServer  (only through `claude mcp add-json`; project required for local/project)
//   DELETE /api/mcp/:name?scope=&project=   -> { ok: true }
//   GET    /api/actions                     -> ActionDef[]
//   POST   /api/actions/:id/run {project?,cwd?,sessionId?} -> { ok: true; output: string }  (409 { error: 'pending approval', command, sha256 })
//   POST   /api/actions/:id/approve {command?} -> ActionDef  (command: the text the user saw; 409 if it changed)
//   POST   /api/open-terminal {cwd,sessionId?} / built-in actions go through /api/actions
//   GET    /api/widgets                     -> { defs: WidgetDef[]; values: WidgetValue[] }
//   POST   /api/widgets  (WidgetDef without id/approved) -> WidgetDef
//   DELETE /api/widgets/:id                 -> { ok: true }
//   PUT    /api/widgets/:id/place {slot, height?} -> WidgetDef
//   POST   /api/widgets/:id/approve {command?, view?} -> WidgetDef  (view: the sha256 of the code the user saw; 409 if it changed)
//   GET    /api/widgets/:id/view           -> the view module (text/javascript), approved code only
//   GET    /api/widgets/:id/view/source    -> { file, sha, text }: the code to review
//
// tools, second batch
//   GET  /api/account?refresh=1             -> AccountStatus  (no LLM call: the CLI's control requests)
//   GET  /api/settings                      -> SettingsView
//   PUT  /api/settings/project/:key  ProjectSettings -> SettingsView
//   PUT  /api/settings/universe  Partial<UniverseOptions> -> SettingsView
//   PUT  /api/settings/home  HomeLayout     -> SettingsView
//   PUT  /api/settings/profile  Partial<Profile> -> SettingsView
//   GET  /api/setup                         -> { setup: SetupState; profile: Profile | null }
//   GET  /api/setup/checks                  -> SetupCheck[]
//   POST /api/setup/start                   -> Tab  (409 while a check fails; the open setup tab is reused)
//   POST /api/setup/restart                 -> SetupState  (back to the checks after completion; the profile stays)
//   POST /api/settings/obsidian/dismiss     -> SettingsView
//   POST /api/ides/scan                     -> SettingsView
//   POST /api/ides/:id/approve              -> SettingsView
//   GET  /api/ides/project/:key             -> ProjectIde
//   POST /api/ides/open {ide?,project?,cwd} -> { ok: true }
//   GET  /api/tabs/:id/commands             -> CommandInfo[]
//   GET  /api/tabs/:id/git                  -> GitStatus
//   GET  /api/tabs/:id/git/diff?path=&area=staged|unstaged|untracked|head -> GitDiff
//   GET  /api/tabs/:id/git/commit/:hash     -> { files: GitFile[]; message: string }
//   GET  /api/tabs/:id/git/commit/:hash/diff?path= -> GitDiff
//   POST /api/tabs/:id/git/stage {paths}, /unstage {paths}, /commit {message,amend?,pushedConfirmed?} -> { ok: true; output: string }
//   GET  /api/tabs/:id/git/amend            -> GitAmendInfo
//   GET  /api/tabs/:id/git/branches         -> GitBranches
//   GET  /api/tabs/:id/git/compare?ref=     -> GitCompare
//   GET  /api/tabs/:id/git/compare/diff?ref=&path= -> GitDiff
//   GET  /api/tabs/:id/git/log?limit=       -> GitLog
//   GET  /api/tabs/:id/git/stash            -> GitStash[]
//   POST /api/tabs/:id/git/fetch, /pull, /checkout {branch}, /branch/create {name,from?,checkout?}, /branch/rename {from,to}, /branch/delete {branch}, /rollback {path}, /ignore {path}, /stash {message,untracked?}, /stash/pop {ref} -> { ok: true; output: string }
//   GET  /api/tabs/:id/git/push             -> GitPushPreview
//   POST /api/tabs/:id/git/push {branch,remote,ahead,publish?} -> { ok: true; output: string }  (no force; 409 if the state changed)
//   GET  /api/usage-log?session=&project=&kind=&limit= -> UsageEntry[]
//   GET  /api/usage-log/skills              -> (UsageTotals & { name: string })[]
//   GET  /api/memory/notes/:id/usage        -> UsageTotals
//   GET  /api/memory/vault                  -> VaultStatus
//   POST /api/memory/vault/copy             -> { ok: true; copied: number; conflicts: number }
//   GET  /api/claude-md?project=            -> ClaudeMdReport
//   POST /api/claude-md/open {scope,project?} -> { ok: true }
//   POST /api/claude-md/preview {scope,project?,content} -> { diff }
//   PUT  /api/claude-md {scope,project?,content,version} -> ClaudeMdFile  (backup, audit; 409 if the file changed)
//   GET  /api/admin/skills                  -> SkillsReport
//   GET  /api/admin/mcp                     -> McpReport
//   POST /api/admin/mcp/status {project?: key | '*'} -> McpReport  (the CLI's own status, no prompt, no tokens)
//   GET  /api/admin/mcp/details?name=&place= -> McpServerDetails
//   POST /api/mcp/:name/login {project?}    -> { ok: true; command: string }  (a terminal with `claude mcp login`)
//   GET  /api/admin/hooks                   -> HooksReport
//   GET  /api/admin/plugins                 -> PluginsReport
//   GET  /api/admin/forecast                -> Forecast
//   GET  /api/project-icons                 -> ProjectIcons
//   POST /api/project-icons/dismiss-offer   -> ProjectIcons
//   GET  /api/project-icons/library?q=      -> IconLibrary
//   PUT  /api/project-icons/:key {icon: name | null} -> ProjectIcons
//   GET  /api/os-plugins                    -> OsPluginsReport
//   POST /api/os-plugins/:id/preview {action} -> OsPluginPlan
//   POST /api/os-plugins/:id/enable|disable|update {confirmed: true, sha} -> OsPluginsReport
//   GET  /api/os-plugins/ui                 -> OsPluginUi[]
//   GET  /api/os-plugins/:id/:tree/ui/*     -> the plugin's interface code
//   GET  /api/project-kit/status            -> KitStatusReport  (server/tools/projectKit.ts; types in shared/projectKit.ts)
//   GET  /api/project-kit/plans/:id         -> KitPlan  (the stored plan with diffs, for the plan card)
//   POST /api/project-kit/plans/:id/approve {requestId} -> { ok: true }  (only the open kit_apply card of the plan; kit_apply refuses without it)
//   PUT  /api/tabs/:id/file {path, text, sha} -> ProjectFile (needs files.write)
//   POST /api/tabs/:id/reveal {path}        -> {ok} (needs files.reveal)
//   POST /api/settings/obsidian/recheck     -> SettingsView
//   POST /api/settings/obsidian/open {url}  -> { ok: true }
//   GET  /api/recovery                      -> RecoveryItem[]
//   POST /api/recovery/tabs/:id/dismiss     -> { ok }  (the turn stays cut off, the tab and its held messages stay)
//   POST /api/recovery/tabs/:id/queue/:queueId/send   -> { ok }
//   DELETE /api/recovery/tabs/:id/queue/:queueId      -> { ok }
//   POST /api/recovery/sessions/:id/dismiss -> { ok }  (continuing one is POST /api/tabs { resumeSessionId })
//   GET  /api/microtasks                    -> Microtask[]
//   GET  /api/planner                       -> { dir, folders: PlannerFolder[], notes: PlannerNote[] }
//   POST /api/planner { text }              -> PlannerNote  (saved to the inbox)
//   GET  /api/planner/:id                   -> PlannerNote
//   PUT  /api/planner/:id { text, version } -> PlannerNote  (409: the text changed since that version)
//   PATCH /api/planner/:id { title }        -> PlannerNote
//   POST /api/planner/:id/file              -> PlannerNote  (the hidden service session splits it into items, titles and files it)
//   PUT  /api/planner/:id/folder { folder } -> { ok }  (a folder id, or null to take it out)
//   POST /api/planner/folders { name }      -> PlannerFolder  (409: the name is taken)
//   PATCH /api/planner/folders/:id { name } -> PlannerFolder
//   DELETE /api/planner/folders/:id         (its notes stay, in no folder)
//   DELETE /api/planner/:id
//   POST   /api/planner/images { base64 }               -> { path }  (absolute: goes into the note's text as a line)
//   GET    /api/planner/images/:name                    -> the image
//   GET  /api/tabs/:id/tree?path=           -> FileEntry[]  (one level, inside the tab's cwd)
//   GET  /api/tabs/:id/file?path=           -> ProjectFile
//   GET  /api/projects/:key/setup           -> ProjectSetup
//   POST /api/projects/:key/setup/preview {scope,text} -> { diff }
//   PUT  /api/projects/:key/setup/:scope {text} -> ProjectSetup
//   POST /api/projects/:key/promote/preview PromoteRequest -> PromotePreview
//   POST /api/projects/:key/promote  PromoteRequest & {confirmed:true} -> ProjectSetup
//
// platform (server/index.ts)
//   POST /api/app/shutdown                  -> { ok: true; stopped: number }  (stops every tab's process, then the server exits)
//   GET  /auth?token=                       sets the cookie, redirects to /
//   GET  /health                            -> { ok: true, pid } (no token, no data)
