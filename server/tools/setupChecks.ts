// First-run setup: deterministic checks of the machine (no prompt is sent), then a tab where Claude asks the user and saves the profile.
import { exec, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AccountStatus, SetupCheck, SetupCheckId, Tab } from '../../shared/contract.ts';
import { resolveClaudeBin, type Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';

// The CLI version the installed @anthropic-ai/claude-agent-sdk is built against: "claudeCodeVersion" in its package.json.
// The constant is the value of SDK 0.3.318, for a package.json that cannot be read; a test keeps the two equal.
export const FALLBACK_MIN_CLAUDE_VERSION = '2.1.318';
export function sdkClaudeVersion(): string | null {
  return safely(() => {
    const pkg = join(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'package.json');
    const v = (JSON.parse(readFileSync(pkg, 'utf8')) as { claudeCodeVersion?: unknown }).claudeCodeVersion;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  }, null);
}
export const MIN_CLAUDE_VERSION = sdkClaudeVersion() ?? FALLBACK_MIN_CLAUDE_VERSION;
export const MIN_NODE = '22.18.0';
export const LIMIT_WARN_PERCENT = 90;
const REJECTED_RECENT_MS = 5 * 3600_000; // a rejected event without a reset time counts for one session window
const SETUP_MODEL = 'sonnet'; // the onboarding is a short talk: no need for the largest model
const SETUP_EFFORT = 'low';
const SETUP_TITLE = 'Setup';
const EXEC_TIMEOUT_MS = 10_000;
const REPO_LIMIT = 20;
const SCAN_LIMIT = 2000; // folders looked at under home, so a huge home folder cannot stall the start

export interface SetupCheckDeps {
  claudeBin: string;
  exists(p: string): boolean;
  claudeVersion(): Promise<string | null>; // the output of `claude --version`
  account(): Promise<AccountStatus>;
  nodeVersion: string;
  hasGit(): Promise<boolean>;
  projectsDir: string | null; // null: not chosen yet
  writable(p: string): boolean;
}

const semver = (text: string | null): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? m.slice(1).map(Number) : null;
};

function atLeast(found: number[], min: string): boolean {
  const want = semver(min)!;
  for (let i = 0; i < 3; i++) if (found[i] !== want[i]) return found[i] > want[i];
  return true;
}

// The window or event that makes the limit worth a warning, null when there is none.
function hotLimit(account: AccountStatus, now: number): SetupCheck['limit'] | null {
  const head = account.windows.find((w) => w.active);
  const hot = account.windows.find((w) => (w.percent ?? 0) >= 100) ?? (head && (head.percent ?? 0) >= LIMIT_WARN_PERCENT ? head : undefined);
  if (hot) return { percent: hot.percent, resetsAt: hot.resetsAt };
  const rejected = account.events.find((e) => e.status === 'rejected' && (e.resetsAt !== null ? e.resetsAt > now : e.receivedAt > now - REJECTED_RECENT_MS));
  return rejected ? { percent: rejected.utilization, resetsAt: rejected.resetsAt } : null;
}

export async function runSetupChecks(deps: SetupCheckDeps): Promise<SetupCheck[]> {
  const out: SetupCheck[] = [];
  const add = (id: SetupCheckId, status: SetupCheck['status'], detail: string | null = null, extra: Partial<SetupCheck> = {}) => out.push({ id, status, detail, ...extra });

  const binary = deps.exists(deps.claudeBin);
  add('claude-binary', binary ? 'ok' : 'fail', deps.claudeBin);
  if (!binary) {
    // Nothing to ask without the CLI. Limits only ever warn, so they stay a warning here too.
    add('claude-version', 'fail', 'unknown');
    add('login', 'fail', 'unknown');
    add('plan', 'fail', 'unknown');
    add('limits', 'warn', 'unknown');
  } else {
    const version = semver(await deps.claudeVersion().catch(() => null));
    add('claude-version', version && atLeast(version, MIN_CLAUDE_VERSION) ? 'ok' : 'fail', version ? version.join('.') : 'unreadable');

    let account: AccountStatus | null = null;
    let error: string | null = null;
    try {
      account = await deps.account();
    } catch (err) {
      error = (err as Error).message.split('\n')[0];
    }
    const hasPlan = account !== null && (account.billing !== 'unknown' || account.plan !== null);
    const loggedIn = account !== null && (hasPlan || !account.error);
    add('login', loggedIn ? 'ok' : 'fail', loggedIn ? null : error ?? account?.error ?? null);
    add('plan', hasPlan ? 'ok' : 'fail', !loggedIn ? 'unknown' : account?.billing === 'api' ? 'api' : account?.plan ?? null);
    const limit = account && hotLimit(account, Date.now());
    if (!loggedIn) add('limits', 'warn', 'unknown');
    else if (limit) add('limits', 'warn', null, { limit });
    else add('limits', 'ok');
  }

  const node = semver(deps.nodeVersion);
  add('node', node && atLeast(node, MIN_NODE) ? 'ok' : 'fail', deps.nodeVersion);
  add('git', (await deps.hasGit().catch(() => false)) ? 'ok' : 'warn');
  if (deps.projectsDir === null) add('projects-dir', 'ok');
  else add('projects-dir', deps.writable(deps.projectsDir) ? 'ok' : 'fail', deps.projectsDir);
  return out;
}

// What the onboarding needs from the machine, found here so the setup session has no tool to run before its first question.
export interface SetupFacts {
  gitName: string | null;
  homeName: string;
  locale: string | null;
  projectFolders: { path: string; repos: number }[]; // parents of git repositories under home, most repositories first
  memoryProjects: number; // folders in ~/.claude/projects with notes in memory/: counted, never read
}

const subdirs = (p: string): string[] => safely(() => readdirSync(p, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
  .map((d) => join(p, d.name)).sort(), []);

// Git repositories at most two levels under home, up to REPO_LIMIT.
export function findRepos(home: string): string[] {
  const found: string[] = [];
  let seen = 0;
  for (const one of subdirs(home)) {
    if (found.length >= REPO_LIMIT || ++seen > SCAN_LIMIT) break;
    if (existsSync(join(one, '.git'))) {
      found.push(one);
      continue;
    }
    for (const two of subdirs(one)) {
      if (found.length >= REPO_LIMIT || ++seen > SCAN_LIMIT) break;
      if (existsSync(join(two, '.git'))) found.push(two);
    }
  }
  return found;
}

export async function collectSetupFacts(o: { home: string; claudeDir: string; env: NodeJS.ProcessEnv; gitName(): Promise<string | null> }): Promise<SetupFacts> {
  const counts = new Map<string, number>();
  for (const repo of findRepos(o.home)) counts.set(dirname(repo), (counts.get(dirname(repo)) ?? 0) + 1);
  const projects = join(o.home, 'Projects');
  if (!counts.has(projects) && existsSync(projects)) counts.set(projects, 0);
  const memoryProjects = subdirs(join(o.claudeDir, 'projects'))
    .filter((p) => safely(() => readdirSync(join(p, 'memory')).some((f) => f.endsWith('.md')), false)).length;
  return {
    gitName: (await o.gitName().catch(() => null)) || null,
    homeName: basename(o.home),
    locale: o.env.LC_ALL || o.env.LC_MESSAGES || o.env.LANG || safely(() => Intl.DateTimeFormat().resolvedOptions().locale, null),
    projectFolders: [...counts].map(([path, repos]) => ({ path, repos })).sort((a, b) => b.repos - a.repos),
    memoryProjects,
  };
}

// Names and paths come from the machine, so they go in as data: one JSON block without control characters,
// and a backtick written as \u0060 so nothing can close the fence.
export function setupPrompt(template: string, f: SetupFacts): string {
  const json = JSON.stringify(f, (_key, v: unknown) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, '') : v), 2).replaceAll('`', '\\u0060');
  return [template.trimEnd(), '', '## What the server found', '', '```json', json, '```', ''].join('\n');
}

// A .cmd shim on Windows runs only through the shell, as one command line: the arguments here are fixed words.
const run = (bin: string, args: string[]) => new Promise<string | null>((done) => {
  const finish = (err: Error | null, stdout: string | Buffer) => done(err ? null : String(stdout).trim());
  if (process.platform === 'win32' && /\.cmd$/i.test(bin)) exec(`"${bin}" ${args.join(' ')}`, { timeout: EXEC_TIMEOUT_MS }, finish);
  // A script runs through node, as the SDK starts it: it need not be executable.
  else if (/\.(m?js|jsx|tsx?)$/.test(bin)) execFile(process.execPath, [bin, ...args], { timeout: EXEC_TIMEOUT_MS }, finish);
  else execFile(bin, args, { timeout: EXEC_TIMEOUT_MS }, finish);
});

const findClaudeBin = () => resolveClaudeBin({ env: process.env, pathEnv: process.env.PATH ?? '', platform: process.platform, home: homedir(), exists: existsSync });

export function setupCheckDeps(ctx: Ctx, account: () => Promise<AccountStatus>, findBin: () => string = findClaudeBin): SetupCheckDeps {
  // Installed after the server started: "Check again" finds it, and every later CLI call uses it without a restart.
  if (!existsSync(ctx.paths.claudeBin)) {
    const found = findBin();
    if (existsSync(found)) ctx.paths.claudeBin = found;
  }
  return {
    claudeBin: ctx.paths.claudeBin,
    exists: existsSync,
    claudeVersion: () => run(ctx.paths.claudeBin, ['--version']),
    account,
    nodeVersion: process.versions.node,
    hasGit: async () => (await run('git', ['--version'])) !== null,
    projectsDir: ctx.settings?.profile()?.projectsDir ?? null,
    writable: (p) => {
      try {
        accessSync(p, constants.W_OK);
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export const machineFacts = (ctx: Ctx, home: string) => () => collectSetupFacts({ home, claudeDir: ctx.paths.claudeDir, env: process.env, gitName: () => run('git', ['config', '--global', '--get', 'user.name']) });

export function registerSetupRoutes(ctx: Ctx, checks: () => Promise<SetupCheck[]>, facts: () => Promise<SetupFacts>): void {
  const { app } = ctx;
  const settings = () => {
    if (!ctx.settings) throw httpError(503, 'settings are not loaded');
    return ctx.settings;
  };

  app.get('/api/setup', async () => ({ setup: settings().setup(), profile: settings().profile() }));
  app.get('/api/setup/checks', async () => checks());

  // One setup tab: a second start, or a start after a reload, lands in the open one. Starts that overlap share one run,
  // or both would wait for the facts and then open a tab each.
  let starting: Promise<Tab> | null = null;
  app.post('/api/setup/start', async () => {
    starting ??= start().finally(() => { starting = null; });
    return starting;
  });
  // "Run setup again" from the menu: back to the checks, and the next start opens a new tab. The profile stays.
  app.post('/api/setup/restart', async () => {
    if (settings().setup().completedAt === null) throw httpError(409, 'Setup is not done yet', 'setupNotDone');
    settings().saveSetup({ step: 'checks', completedAt: null, tabId: null });
    return settings().setup();
  });

  async function start(): Promise<Tab> {
    if (settings().setup().completedAt !== null) throw httpError(409, 'Setup is already done', 'setupAlreadyDone');
    if ((await checks()).some((c) => c.status === 'fail')) throw httpError(409, 'A setup check fails: fix it and check again', 'setupChecksFailed');
    const chat = ctx.chat;
    if (!chat) throw httpError(503, 'chat is not running');
    const prompt = async () => setupPrompt(readFileSync(join(ctx.paths.setup, 'SETUP.md'), 'utf8'), await facts());
    const { tabId } = settings().setup();
    const open = tabId ? chat.list().find((t) => t.id === tabId) : undefined;
    if (open) {
      settings().saveSetup({ step: 'onboarding' });
      // No session yet and nothing running: the first prompt never reached Claude.
      if (open.sessionId || open.status !== 'idle') return open;
      chat.get(open.id).send({ text: await prompt() });
      return chat.list().find((t) => t.id === open.id) ?? open;
    }
    const text = await prompt();
    const tab = chat.create({ cwd: ctx.paths.setup, title: SETUP_TITLE, model: SETUP_MODEL, effort: SETUP_EFFORT, source: 'setup' });
    // Saved before the first message: the process starts with it, and only this tab id gets the setup tools.
    settings().saveSetup({ step: 'onboarding', tabId: tab.id });
    ctx.broadcast({ t: 'tab_opened', tab, focus: true });
    chat.get(tab.id).send({ text });
    return chat.list().find((t) => t.id === tab.id) ?? tab;
  }
}
