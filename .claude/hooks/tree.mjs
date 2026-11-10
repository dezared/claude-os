// The working tree a hook acts on: the git root of the session's cwd. A Claude OS tab in a worktree keeps CLAUDE_PROJECT_DIR at the main checkout.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function workTree(input) {
  const start = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || '.');
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return start;
  }
}
