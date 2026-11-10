// Stop: runs the gate when the working tree differs from the last green one; gives up after 3 blocks in a row.
// Outside git, the dirty flag that after-edit sets stands in for the tree fingerprint.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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

const [{ dirtyFlag, failOpen, gitPath, invoked, projectRoot, readInput, readKit, readState, saveState }, { runKitGate }] = await load('stop-gate', ['../metrics.mjs', '../gate.mjs']);

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
  if (fp === state.green || (clean && (head ?? null) === (state.head ?? null))) return 'skip';
  return state.blocks >= MAX_BLOCKS ? 'give-up' : 'run';
}

const git = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });

// Git stores a symlink as its target, so hash the target rather than follow it; an untracked nested repo is listed as a directory.
function content(file) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(file));
  return stat.isDirectory() ? Buffer.alloc(0) : readFileSync(file);
}

function snapshot(cwd) {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).toString().trim();
  const diff = git(['diff', 'HEAD', '--binary', '--relative'], cwd).toString();
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((p) => ({ path: p, content: content(path.join(cwd, p)) }));
  return { head, diff, untracked };
}

// What the decision needs, with or without git; a repo with no commit yet has no HEAD to diff against.
function treeState(root) {
  if (!gitPath(root, '--git-dir')) return { fp: 'dirty', clean: !existsSync(dirtyFlag(root)), head: null };
  let snap;
  try {
    snap = snapshot(root);
  } catch {
    // Never equal to a saved green: the gate runs on every stop until the first commit.
    return { fp: `no-head:${Date.now()}`, clean: false, head: null };
  }
  return { fp: fingerprint(snap), clean: snap.diff === '' && snap.untracked.length === 0, head: snap.head };
}

// Package manager banners, blank lines and dot-reporter rows carry nothing for the reader.
const NOISE = /^(> .*|\s*|[.X]+)$/;

function clip(text, max) {
  const lines = text.split('\n').filter((line) => !NOISE.test(line));
  return lines.length <= max ? lines.join('\n') : [...lines.slice(0, max - 1), `... ${lines.length - max + 1} more lines`].join('\n');
}

const say = (message) => console.log(JSON.stringify({ systemMessage: message }));

async function gate(root, config, state, tree) {
  const result = await runKitGate({ root, config });
  // A step stopped at the time limit is no verdict to block on; the next stop runs the gate again.
  if (result.timedOut) {
    say(result.notice);
    return 0;
  }
  if (result.ok) {
    // Outside git there is no fingerprint: the cleared flag is the green mark.
    rmSync(dirtyFlag(root), { force: true });
    saveState(root, { green: tree.fp === 'dirty' ? null : tree.fp, head: tree.head, blocks: 0, red: '' });
    if (result.notice) say(result.notice);
    return 0;
  }
  const red = clip(`${result.notice ?? ''}\ngate: red at ${result.failed}\n${result.output}`, MAX_LINES - 1);
  saveState(root, { blocks: state.blocks + 1, red });
  process.stderr.write(`stop-gate: the gate is red, fix it before stopping (block ${state.blocks + 1} of ${MAX_BLOCKS}).\n${red}\n`);
  return 2;
}

async function main() {
  const root = projectRoot(readInput().cwd);
  const config = readKit(root);
  const state = readState(root);
  const tree = treeState(root);
  const decision = stopDecision(state, tree.fp, tree.clean, tree.head);
  if (decision === 'skip') return 0;
  if (decision === 'give-up') {
    // The next turn starts a fresh count, so a red tree is checked again later.
    saveState(root, { blocks: 0 });
    say(`stop-gate: still red after ${MAX_BLOCKS} blocks, stopping.\n${state.red}`);
    return 0;
  }
  return gate(root, config, state, tree);
}

if (invoked(import.meta.url)) await failOpen('stop-gate', main);
