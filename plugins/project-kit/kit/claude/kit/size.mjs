// The size check: non-blank lines per source file against the limit, or against the file's cap in size-baseline.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invoked, projectRoot, readKit } from './metrics.mjs';

export const BASELINE = '.claude/kit/size-baseline.json';

// Source files per stack; the suppression scan and after-edit use the same map.
export const STACK_FILES = {
  ts: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/,
  python: /\.pyi?$/,
  go: /\.go$/,
  rust: /\.rs$/,
};
const UI = /\.(tsx|jsx|vue|svelte)$/;
const TESTS = [/(^|\/)(tests?|__tests__|spec|e2e)\//, /\.(test|spec)\.[^/]+$/, /(^|\/)test_[^/]+\.py$/, /_test\.(py|go)$/];
// Never walked outside git: dependencies, caches and build output.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv', 'vendor']);

export const countLines = (text) => text.split('\n').filter((line) => line.trim() !== '').length;
export const isUi = (file) => UI.test(file);
export const isTest = (file) => TESTS.some((re) => re.test(file));
export const isSource = (file) => Object.values(STACK_FILES).some((re) => re.test(file));

function globRegex(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, (m) => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[m]);
  return new RegExp(`^${body}$`);
}

// `dir/` is a folder (at any depth when it has no slash), a glob uses * and **, anything else is a path or a folder prefix.
export function matchesGlob(file, pattern) {
  const p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) {
    const dir = p.slice(0, -1);
    return file.startsWith(`${dir}/`) || (!dir.includes('/') && file.split('/').slice(0, -1).includes(dir));
  }
  if (/[*?]/.test(p)) return globRegex(p).test(file) || (!p.includes('/') && globRegex(p).test(path.posix.basename(file)));
  return file === p || file.startsWith(`${p}/`);
}

export const matchesAny = (file, patterns) => patterns.some((p) => matchesGlob(file, p));

export const isCounted = (file, generated) => isSource(file) && !isTest(file) && !matchesAny(file, generated);

function walk(root, dir = '') {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isFile()) return [rel];
    const skipped = !entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name);
    return skipped ? [] : walk(root, rel);
  });
}

// Tracked and new non-ignored files in git; outside git, a walk that skips hidden and build folders.
export function projectFiles(root) {
  let listed;
  try {
    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
    listed = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return walk(root);
  }
  return [...new Set(listed.split('\0').filter(Boolean))].filter((file) => existsSync(path.join(root, file)));
}

// The baseline may only lose entries or lower caps against HEAD.
function ratchet(baseline, head) {
  return Object.entries(baseline).flatMap(([file, cap]) => {
    if (!(file in head)) return [`${BASELINE}: ${file} was added; the baseline may only lose entries`];
    return cap > head[file] ? [`${BASELINE}: ${file} cap ${head[file]} -> ${cap}; caps may only go down`] : [];
  });
}

export function sizeViolations({ counts, baseline, headBaseline, limits }) {
  const found = Object.entries(counts).flatMap(([file, n]) => {
    const cap = baseline[file];
    const limit = isUi(file) ? limits.ui : limits.file;
    if (cap === undefined) return n > limit ? [`${file}: ${n} lines; the limit is ${limit}, split the file`] : [];
    return n > cap ? [`${file}: ${n} lines; its cap in ${BASELINE} is ${cap}, split the file`] : [];
  });
  return headBaseline ? [...found, ...ratchet(baseline, headBaseline)] : found;
}

// Only downward: each cap drops to the file's current size, an entry at or under the limit (or gone) leaves; nothing is raised or added.
export function tightenBaseline({ counts, baseline, limits }) {
  const next = {};
  for (const [file, cap] of Object.entries(baseline)) {
    const n = counts[file] ?? 0;
    if (n > (isUi(file) ? limits.ui : limits.file)) next[file] = Math.min(cap, n);
  }
  return next;
}

function readJson(read) {
  try {
    return JSON.parse(read());
  } catch {
    return null;
  }
}

function countFiles(root, config) {
  const counts = {};
  for (const file of projectFiles(root)) {
    if (isCounted(file, config.protected ?? [])) counts[file] = countLines(readFileSync(path.join(root, file), 'utf8'));
  }
  return counts;
}

const readBaseline = (root) => readJson(() => readFileSync(path.join(root, BASELINE), 'utf8')) ?? {};

export function checkSize(root, config) {
  // `./`: relative to the project, which may sit inside a parent repo.
  const show = ['show', `HEAD:./${BASELINE}`];
  return sizeViolations({
    counts: countFiles(root, config),
    baseline: readBaseline(root),
    headBaseline: readJson(() => execFileSync('git', show, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
    limits: config.limits,
  });
}

// `node .claude/kit/size.mjs --tighten`: the way to lower caps, since edits under .claude/kit/ are denied.
function tighten(root, config) {
  const before = readBaseline(root);
  const after = tightenBaseline({ counts: countFiles(root, config), baseline: before, limits: config.limits });
  if (existsSync(path.join(root, BASELINE))) writeFileSync(path.join(root, BASELINE), `${JSON.stringify(after, null, 2)}\n`);
  const changed = Object.keys(before).filter((file) => after[file] !== before[file]);
  for (const file of changed) console.log(`${file}: ${before[file]} -> ${after[file] ?? 'removed'}`);
  console.log(`size: ${changed.length} baseline entr${changed.length === 1 ? 'y' : 'ies'} tightened`);
  return 0;
}

function main() {
  const root = projectRoot(process.cwd());
  if (process.argv.includes('--tighten')) return tighten(root, readKit(root));
  const found = checkSize(root, readKit(root));
  for (const line of found) console.log(line);
  console.log(found.length ? `size: ${found.length} file(s) over the limit` : 'size: clean');
  return found.length ? 1 : 0;
}

if (invoked(import.meta.url)) process.exitCode = main();
