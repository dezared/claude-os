// Stop: runs the gate when the working tree differs from the last green one; gives up after 3 blocks in a row.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workTree } from './tree.mjs';

const MAX_BLOCKS = 3;
const MAX_LINES = 60;
const BUFFER = 256 * 1024 * 1024;

export function fingerprint({ head, diff, untracked }) {
  const hash = createHash('sha256').update(`${head}\0${diff.length}\0`).update(diff);
  for (const file of untracked) hash.update(`\0${file.path}\0${file.content.length}\0`).update(file.content);
  return hash.digest('hex');
}

// A clean tree at the HEAD of the last green run means nothing to check; a commit since then (an edit and a commit in one turn) is checked.
export function stopDecision(state, fp, clean, head) {
  if (fp === state.green || (clean && head === state.head)) return 'skip';
  return state.blocks >= MAX_BLOCKS ? 'give-up' : 'run';
}

const git = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: BUFFER });

// Git stores a symlink as its target, so hash the target rather than follow it; an untracked nested repo is listed as a directory.
function content(file) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(file));
  return stat.isDirectory() ? Buffer.alloc(0) : readFileSync(file);
}

function snapshot(cwd) {
  const head = git(['rev-parse', 'HEAD'], cwd).toString().trim();
  const diff = git(['diff', 'HEAD', '--binary'], cwd).toString();
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((p) => ({ path: p, content: content(path.join(cwd, p)) }));
  return { head, diff, untracked };
}

// npm's `> script` banners, blank lines and the dot reporter's progress rows carry nothing for the reader.
const NOISE = /^(> .*|\s*|[.X]+)$/;

function clip(text, max) {
  const lines = text.split('\n').filter((line) => !NOISE.test(line));
  return lines.length <= max ? lines.join('\n') : [...lines.slice(0, max - 1), `... ${lines.length - max + 1} more lines`].join('\n');
}

function runGate(cwd) {
  const gate = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/gate.ts'], { cwd, encoding: 'utf8', maxBuffer: BUFFER });
  return { ok: gate.status === 0, output: `${gate.stdout ?? ''}${gate.stderr ?? ''}${gate.error?.message ?? ''}` };
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const cwd = workTree(input);
  // Per worktree and never tracked: <git-dir> is .git/worktrees/<name> in a worktree.
  const file = path.resolve(cwd, git(['rev-parse', '--git-dir'], cwd).toString().trim(), 'claude-gate.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { green: null, blocks: 0, red: '' };
  const save = (next) => writeFileSync(file, `${JSON.stringify(next)}\n`);
  const snap = snapshot(cwd);
  const fp = fingerprint(snap);
  const decision = stopDecision(state, fp, snap.diff === '' && snap.untracked.length === 0, snap.head);
  if (decision === 'skip') return;
  if (decision === 'give-up') {
    // The next turn starts a fresh count, so a red tree is checked again later.
    save({ ...state, blocks: 0 });
    console.log(JSON.stringify({ systemMessage: `stop-gate: still red after ${MAX_BLOCKS} blocks, stopping.\n${state.red}` }));
    return;
  }
  const gate = runGate(cwd);
  if (gate.ok) return save({ green: fp, head: snap.head, blocks: 0, red: '' });
  const red = clip(gate.output, MAX_LINES - 1);
  save({ ...state, blocks: state.blocks + 1, red });
  process.stderr.write(`stop-gate: the gate is red, fix it before stopping (block ${state.blocks + 1} of ${MAX_BLOCKS}).\n${red}\n`);
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
