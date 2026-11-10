// SessionStart: a few lines on where the work stands; stray branches and worktrees are named (main is the only long-lived branch).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workTree } from './tree.mjs';

const SHOWN = 6;
const OPEN_ITEM = /^\s*- \[ \]/gm;

const list = (names) => (names.length <= SHOWN ? names.join(', ') : `${names.slice(0, SHOWN).join(', ')} and ${names.length - SHOWN} more`);

export function briefingLines({ branch, dirty, branches, worktrees, openItems, plan, handoff }) {
  const strayBranches = branches.filter((name) => name !== 'main');
  const lines = [`branch ${branch || '(detached)'}, ${dirty} uncommitted ${dirty === 1 ? 'path' : 'paths'}`];
  if (strayBranches.length) lines.push(`branches besides main (merge and delete when done): ${list(strayBranches)}`);
  if (worktrees.length) lines.push(`worktrees besides main: ${list(worktrees)}`);
  if (plan) lines.push(`latest plan: ${plan}, ${openItems} open items`);
  if (handoff) lines.push(`latest handoff: ${handoff}`);
  return lines;
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const nonEmpty = (text) => text.split('\n').filter(Boolean);

// Worktrees other than the one on main, relative to the main checkout (listed first).
function worktrees(cwd) {
  const entries = git(['worktree', 'list', '--porcelain'], cwd).split('\n\n').map(nonEmpty);
  const main = entries[0][0].slice('worktree '.length);
  return entries
    .filter((entry) => !entry.includes('branch refs/heads/main'))
    .map((entry) => path.relative(main, entry[0].slice('worktree '.length)) || '.');
}

// Newest by the date in the name, then by modification time.
function latest(cwd, dir) {
  const abs = path.join(cwd, dir);
  if (!existsSync(abs)) return null;
  const files = readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(abs, entry.name)).mtimeMs }))
    .sort((a, b) => a.name.slice(0, 10).localeCompare(b.name.slice(0, 10)) || a.mtime - b.mtime);
  return files.length ? `${dir}/${files[files.length - 1].name}` : null;
}

function main() {
  const cwd = workTree(JSON.parse(readFileSync(0, 'utf8')));
  const plan = latest(cwd, 'docs/plans');
  const out = briefingLines({
    branch: git(['branch', '--show-current'], cwd),
    dirty: nonEmpty(git(['status', '--porcelain'], cwd)).length,
    branches: nonEmpty(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd)),
    worktrees: worktrees(cwd),
    openItems: plan ? (readFileSync(path.join(cwd, plan), 'utf8').match(OPEN_ITEM) ?? []).length : 0,
    plan,
    handoff: latest(cwd, 'docs/handoff'),
  });
  console.log(out.join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
