// PreToolUse Edit|Write: refuses edits to user data, generated files, git internals, settings, the hooks themselves and any loosening of .oxlintrc.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workTree } from './tree.mjs';

const TOP = new Map([
  ['data', 'user data'],
  ['.git', 'git internals'],
  ['dist', 'build output'],
  ['node_modules', 'installed packages'],
  ['.githooks', 'the git hooks the gate relies on'],
  ['package-lock.json', 'the lock file; change dependencies with npm'],
  ['CLAUDE.local.md', "the user's local instructions"],
]);
// Under .claude/: what the user changes.
const USER_OWNED = [
  [/^\.claude\/hooks\//, 'hooks'],
  [/^\.claude\/settings[^/]*\.json$/, 'settings'],
];

export function protectReason(filePath, projectDir) {
  const root = path.resolve(projectDir);
  const rel = path.relative(root, path.resolve(root, filePath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const shown = parts.join('/');
  if (TOP.has(parts[0])) return `${shown} is protected: ${TOP.get(parts[0])}.`;
  const owned = USER_OWNED.find(([pattern]) => pattern.test(shown));
  if (owned) return `${shown} is protected: ${owned[1]} are changed by the user, propose the change instead.`;
  if (parts[parts.length - 1].startsWith('.env')) return `${shown} is protected: environment files hold secrets.`;
  return null;
}

// The file as the Write or Edit would leave it, or null when an Edit would fail anyway.
function edited(toolInput, file) {
  if (typeof toolInput.content === 'string') return toolInput.content;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(toolInput.old_string)) return null;
  return toolInput.replace_all ? text.split(toolInput.old_string).join(toolInput.new_string) : text.replace(toolInput.old_string, () => toolInput.new_string);
}

// The lint ratchet at edit time: on main the gate compares with HEAD itself and sees nothing.
export async function ratchetReason(toolInput, tree) {
  const file = path.resolve(tree, toolInput.file_path ?? '');
  if (path.relative(tree, file) !== '.oxlintrc.json') return null;
  let base;
  try {
    base = JSON.parse(execFileSync('git', ['show', 'HEAD:.oxlintrc.json'], { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null; // not at HEAD yet: nothing to ratchet against
  }
  const text = edited(toolInput, file);
  if (text === null) return null;
  let current;
  try {
    current = JSON.parse(text);
  } catch {
    return '.oxlintrc.json is not valid JSON after this edit.';
  }
  const { ratchetViolations } = await import('../../scripts/check-lint-ratchet.ts');
  const found = ratchetViolations(base, current);
  return found.length ? `.oxlintrc.json may only tighten against HEAD; this edit loosens it:\n${found.join('\n')}` : null;
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const tree = workTree(input);
  const file = input.tool_input?.file_path ?? '';
  // The main checkout too: its data/ is the live install even when the session runs in a worktree.
  const roots = [tree, process.env.CLAUDE_PROJECT_DIR].filter(Boolean);
  const reason = roots.map((root) => protectReason(file, root)).find(Boolean) ?? (await ratchetReason(input.tool_input ?? {}, tree));
  if (!reason) return;
  process.stderr.write(`protect-files: ${reason}\n`);
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
