// SessionStart: at most eight lines on where the work stands; stray branches and worktrees are named (the default branch is the only long-lived one).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Kit modules load at run time, so a missing one is one warning line and exit 0 (fail-open), not a crash.
async function load(hook, specs) {
  try {
    return await Promise.all(specs.map((spec) => import(spec)));
  } catch (error) {
    console.log(`kit ${hook}: ${String(error?.message ?? error).replace(/\s*\n\s*/g, ' ')}`);
    return specs.map(() => ({ invoked: () => false }));
  }
}

const [{ failOpen, gitPath, invoked, projectRoot, readInput, readKit }, { defaultBranch }] = await load('briefing', ['../metrics.mjs', '../gate.mjs']);

const SHOWN = 6;
const MAX_LINES = 8;
const OPEN_ITEM = /^\s*- \[ \]/gm;

const list = (names) => (names.length <= SHOWN ? names.join(', ') : `${names.slice(0, SHOWN).join(', ')} and ${names.length - SHOWN} more`);

// `branch` is null outside git.
export function briefingLines({ base = 'main', branch, dirty, branches, worktrees, openItems, plan, handoff }) {
  const stray = branches.filter((name) => name !== base);
  const lines = branch === null ? [] : [`branch ${branch || '(detached)'}, ${dirty} uncommitted ${dirty === 1 ? 'path' : 'paths'}`];
  if (stray.length) lines.push(`branches besides ${base} (merge and delete when done): ${list(stray)}`);
  if (worktrees.length) lines.push(`worktrees besides ${base}: ${list(worktrees)}`);
  if (plan) lines.push(`latest plan: ${plan}, ${openItems} open items`);
  if (handoff) lines.push(`latest handoff: ${handoff}`);
  return lines.slice(0, MAX_LINES);
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const nonEmpty = (text) => text.split('\n').filter(Boolean);

// Worktrees other than the one on the default branch, relative to the main checkout (listed first).
function worktrees(cwd, base) {
  const entries = git(['worktree', 'list', '--porcelain'], cwd).split('\n\n').map(nonEmpty);
  const main = entries[0][0].slice('worktree '.length);
  return entries
    .filter((entry) => !entry.includes(`branch refs/heads/${base}`))
    .map((entry) => path.relative(main, entry[0].slice('worktree '.length)) || '.');
}

function gitFacts(cwd) {
  const base = defaultBranch(cwd);
  return {
    base,
    branch: git(['branch', '--show-current'], cwd),
    dirty: nonEmpty(git(['status', '--porcelain'], cwd)).length,
    branches: nonEmpty(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd)),
    worktrees: worktrees(cwd, base),
  };
}

// Newest by the date in the name, then by modification time; README files are not plans.
function latest(cwd, dir) {
  const abs = path.join(cwd, dir);
  if (!existsSync(abs)) return null;
  const files = readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(abs, entry.name)).mtimeMs }))
    .sort((a, b) => a.name.slice(0, 10).localeCompare(b.name.slice(0, 10)) || a.mtime - b.mtime);
  return files.length ? `${dir}/${files[files.length - 1].name}` : null;
}

async function main() {
  const root = projectRoot(readInput().cwd);
  const { docsDir } = readKit(root);
  const plan = latest(root, `${docsDir}/plans`);
  const facts = gitPath(root, '--git-dir') ? gitFacts(root) : { branch: null, dirty: 0, branches: [], worktrees: [] };
  const lines = briefingLines({
    ...facts,
    openItems: plan ? (readFileSync(path.join(root, plan), 'utf8').match(OPEN_ITEM) ?? []).length : 0,
    plan,
    handoff: latest(root, `${docsDir}/handoff`),
  });
  if (lines.length) console.log(lines.join('\n'));
  return 0;
}

if (invoked(import.meta.url)) await failOpen('briefing', main);
