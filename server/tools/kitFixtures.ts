// Sample projects for the project kit tests. They are stored with names Claude Code does not load
// (`CLAUDE.md.tpl`, `claude/`), so sessions in this repo never pick them up as instructions.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KIT_FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'project-kit');

// `nested-in-git` is not listed: its project is the `app/` folder inside the fixture's repo, so tests use it on its own.
export const KIT_FIXTURES = [
  'ts-npm-vitest', 'ts-pnpm-node-test', 'py-uv-pytest', 'py-reqs', 'go', 'rust', 'make-only', 'unknown',
  'existing-claude-md', 'cursor-rules', 'agents-md-long', 'monorepo-ts-py', 'docs-site',
] as const;

// A fixed identity passed per command: the fixture repo gets one author and the user's git config is never touched.
const GIT = ['-c', 'user.name=Kit Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

function restoreNames(dir: string, top: boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let name = entry.name;
    if (entry.isFile() && name === 'CLAUDE.md.tpl') name = 'CLAUDE.md';
    if (entry.isDirectory() && top && name === 'claude') name = '.claude';
    if (name !== entry.name) renameSync(join(dir, entry.name), join(dir, name));
    if (entry.isDirectory()) restoreNames(join(dir, name), false);
  }
}

/** Copies a fixture to a fresh temp folder with its real names and, unless it has a `no-git` marker, one commit. */
export function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `kit-${name}-`));
  cpSync(join(KIT_FIXTURES_DIR, name), root, { recursive: true });
  restoreNames(root, true);
  const noGit = join(root, 'no-git');
  if (existsSync(noGit)) {
    rmSync(noGit);
    return root;
  }
  const git = (...args: string[]) => execFileSync('git', [...GIT, ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'fixture');
  return root;
}
