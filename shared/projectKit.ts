// Types shared by the project kit engine (server/tools/kit*.ts), the kit MCP tools and the web views.
// They live outside contract.ts, which is close to its size cap, like documents.ts and plannerItems.ts.

export const KIT_STACKS = ['ts', 'python', 'go', 'rust'] as const;
export type KitStack = (typeof KIT_STACKS)[number];

export const KIT_STEPS = ['typecheck', 'lint', 'test', 'build', 'e2e', 'format'] as const;
export type KitStep = (typeof KIT_STEPS)[number];

/** A command the kit writes. `from` names its source: `<file>#<key>` or `PATH:<bin>`, never invented. */
export interface KitCommand { step: KitStep; run: string; cwd: string; from: string }

/** A step left out because its tool is missing; `skipped` reads `<tool> not found`. */
export interface KitSkipped { step: KitStep; skipped: string }

export type RelatedMode = 'vitest' | 'jest' | 'node-test' | 'testmon' | 'pytest-name' | 'go' | 'stop' | 'none';

export type KitAmbiguity = 'package-managers' | 'monorepo' | 'authors';

export interface KitDetection {
  stacks: { stack: KitStack; dir: string; runner: string | null }[];
  commands: KitCommand[];
  skipped: KitSkipped[];
  related: { dir: string; mode: RelatedMode }[];
  formatter: KitCommand | null;
  docsDir: 'docs' | 'dev-docs';
  generated: string[];
  /** Existing instruction files found in the project, relative paths. */
  instructions: string[];
  ambiguities: KitAmbiguity[];
  git: boolean;
}

export interface KitAnswers { scope?: 'project' | 'local'; limits?: 'strict' | 'relaxed'; packageManager?: string; protected?: string[] }

/** The shape of `.claude/kit/kit.json` in a project. */
export interface KitConfig {
  kit: string;
  stacks: KitDetection['stacks'];
  commands: KitCommand[];
  skipped: KitSkipped[];
  related: KitDetection['related'];
  formatter: KitCommand | null;
  protected: string[];
  limits: { file: number; ui: number; fn: number; complexity: number };
  docsDir: string;
  budgets: { afterEditMs: 10000; stopMs: 90000 };
}

/** The kit_apply tool as canUseTool and the chat see it: its permission card shows the stored plan. */
export const KIT_APPLY_TOOL = 'mcp__claude-os__kit_apply';

export type KitOwner = 'kit' | 'seed' | 'merged';
export type KitFileAction = 'add' | 'update' | 'merge' | 'needs-merge' | 'keep' | 'skip' | 'remove' | 'migrate';

export interface KitPlanFile { path: string; owner: KitOwner; action: KitFileAction; reason: string | null; diff: string }

export interface KitPlan {
  planId: string;
  project: string;
  root: string;
  kitId: string;
  kit: string;
  action: 'install' | 'update' | 'remove';
  files: KitPlanFile[];
  skipped: KitSkipped[];
  ask: string[];
  empty: boolean;
  approved: boolean;
}

export type KitPlanSummary = Omit<KitPlan, 'files'> & { files: Omit<KitPlanFile, 'diff'>[] };

/**
 * `wrote` is what the kit last wrote; `render` is the kit's own render, the base of the next three-way merge.
 * `owner` came later: a lock without it takes the owner from the current render.
 */
export interface KitLockEntry { wrote: string; render: string; owner?: 'kit' | 'seed' }

export interface KitLock {
  kit: string;
  /** The kit plugin; written only for a kit other than DEFAULT_KIT, so locks from before several kits stay byte-identical. */
  id?: string;
  installedAt: number;
  sizeAtInstall: number;
  files: Record<string, KitLockEntry>;
  settings: { file: string; allow: string[]; deny: string[]; ask: string[]; hooks: string[] };
}

/** The shipped kit plugin: a lock without an id was written by it, and a new install takes it while it is enabled. */
export const DEFAULT_KIT = 'project-kit';

export interface KitRef { id: string; version: string }

/** `kit`: the one a new install takes; `kits`: every enabled kit plugin; the installed kit per project key. */
export interface KitStatusReport { kit: KitRef | null; kits: KitRef[]; projects: Record<string, KitRef | null> }

/** What a kit writes into a project, by kind, from its template index; names without folders and extensions. */
export interface KitContents { claudeMd: boolean; rules: string[]; agents: string[]; skills: string[]; checks: string[]; hooks: string[]; docs: string[] }

/** A project the kits screen lists: its installed kit, if any. */
export interface KitProjectRow { key: string; name: string; root: string; kit: KitRef | null; installedAt: number | null }

/** One apply, update or remove, from the audit log (action `project.kit`). */
export interface KitHistoryEntry { at: number; project: string; kit: string; version: string; action: 'install' | 'update' | 'remove'; files: number }

/** GET /api/project-kit/kits: every plugin folder with a kit (enabled or not), the projects and the history. */
export interface KitSetsReport { default: string | null; kits: { id: string; contents: KitContents }[]; projects: KitProjectRow[]; history: KitHistoryEntry[] }

/** The kits screen shows at most this many kits; creating one more is refused by the create flow. */
export const KIT_SETS_MAX = 5;

export type KitHook = 'protect-files' | 'after-edit' | 'stop-gate' | 'briefing';
export interface KitHookMetric { hook: KitHook; ms: number; ok: boolean; ts: number }

export const KIT_METRICS = [
  'startingContext', 'cacheHit', 'subagentShare', 'skillsUsed', 'visibleSkills', 'loopA50', 'loopA90',
  'loopB50', 'loopB90', 'redStops', 'filesOverLimit', 'unpromotedMistakes', 'patternDebt', 'questions',
] as const;
export type KitMetric = (typeof KIT_METRICS)[number];

export interface KitMetricValue { before: number | null; after: number | null }

export interface KitMetricsRow {
  project: string;
  name: string;
  kit: string;
  installedAt: number;
  questionLevel: string | null;
  metrics: Record<KitMetric, KitMetricValue>;
}
