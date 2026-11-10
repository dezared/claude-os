// The kit's shared runtime: project root, kit.json, per-worktree state and the hook metrics. Node only, no dependencies.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_JSON = '.claude/kit/kit.json';
const STATE_DIR = '.claude/kit/state';
const MAX_BYTES = 1048576;

// An absolute path from `git rev-parse <flag>`, or null outside a git work tree.
export function gitPath(cwd, flag) {
  try {
    const out = execFileSync('git', ['rev-parse', flag], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(cwd, out);
  } catch {
    return null;
  }
}

function realPath(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

// A path that may not exist yet with its nearest existing folder resolved; the rest is kept as written.
function realFile(file) {
  const rest = [];
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
    if (existsSync(dir)) return path.join(realPath(dir), ...rest);
    if (path.dirname(dir) === dir) return path.resolve(file);
    rest.unshift(path.basename(dir));
  }
}

// A file's path inside the project root, or null outside it. The root is real (git and projectRoot resolve links), while
// Claude may name the file through a symlinked project folder, so its folder is resolved too; the file name never is.
export function projectPath(root, file) {
  const abs = path.resolve(root, file);
  for (const candidate of [abs, path.join(realFile(path.dirname(abs)), path.basename(abs))]) {
    const rel = path.relative(realFile(root), candidate);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

// The nearest folder with kit.json from the session's cwd up to its git top level, since a project may sit inside a parent repo.
// Without one, the git top level (a Claude OS tab in a worktree keeps CLAUDE_PROJECT_DIR at the main checkout); outside git, the project dir.
export function projectRoot(start) {
  const from = realPath(path.resolve(start || process.env.CLAUDE_PROJECT_DIR || '.'));
  const top = gitPath(from, '--show-toplevel');
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, KIT_JSON))) return dir;
    if (dir === top || path.dirname(dir) === dir) break;
  }
  return top ?? path.resolve(process.env.CLAUDE_PROJECT_DIR || from);
}

export function readKit(root) {
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(root, KIT_JSON), 'utf8'));
  } catch (error) {
    throw new Error(`${KIT_JSON} is unreadable: ${error.message}`, { cause: error });
  }
  if (!config || !Array.isArray(config.commands) || !config.limits) throw new Error(`${KIT_JSON} has no commands or limits`);
  return config;
}

export const readInput = () => JSON.parse(readFileSync(0, 'utf8') || '{}');

// Per worktree and never tracked: <git-dir> is .git/worktrees/<name> in a worktree.
export function stateFile(root) {
  const dir = gitPath(root, '--git-dir');
  return dir ? path.join(dir, 'claude-kit/state.json') : path.join(root, STATE_DIR, 'state.json');
}

// Set by after-edit in a folder without git, where no tree fingerprint exists.
export const dirtyFlag = (root) => path.join(root, STATE_DIR, 'dirty');

export function readState(root) {
  const file = stateFile(root);
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { green: null, head: null, blocks: 0, slow: false, red: '', ...saved };
}

export function saveState(root, patch) {
  const file = stateFile(root);
  const next = { ...readState(root), ...patch };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next)}\n`);
  return next;
}

// Shared by all worktrees and outside the tracked tree.
export function metricsFile(cwd) {
  const common = gitPath(cwd, '--git-common-dir');
  return common ? path.join(common, 'claude-kit/metrics.jsonl') : path.join(projectRoot(cwd), STATE_DIR, 'metrics.jsonl');
}

export function appendMetric(file, entry, maxBytes = MAX_BYTES) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  if (statSync(file).size <= maxBytes) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
}

// A hook's own error never blocks the user: one warning line, exit 0. Every run is timed into metrics.jsonl.
export async function failOpen(hook, main) {
  const started = Date.now();
  let code = 0;
  let ok = false;
  try {
    code = (await main()) ?? 0;
    ok = code === 0;
  } catch (error) {
    code = 0;
    console.log(`kit ${hook}: ${String(error?.message ?? error).replace(/\s*\n\s*/g, ' ')}`);
  }
  try {
    appendMetric(metricsFile(process.cwd()), { hook, ms: Date.now() - started, ok, ts: Date.now() });
  } catch {
    // Metrics are best effort; a read-only .git must not turn into a hook failure.
  }
  process.exitCode = code;
}

export const invoked = (url) => process.argv[1] === fileURLToPath(url);
