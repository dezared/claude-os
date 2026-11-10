import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionInfo } from '../../shared/contract.ts';

const run = promisify(execFile);
const MAX_STATE_CHARS = 1000;

export interface GitInfo {
  branch: string | null;
  changed: string[];
}

export async function gitInfo(root: string): Promise<GitInfo> {
  const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '-C', root, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  try {
    const branch = (await git('branch', '--show-current')).trim() || null;
    const changed = (await git('status', '--porcelain')).split('\n').filter(Boolean).map((l) => l.trim());
    return { branch, changed };
  } catch {
    return { branch: null, changed: [] };
  }
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function renderState(key: string, sessions: SessionInfo[], git: GitInfo): string {
  const sorted = [...sessions].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const active = sorted.filter((s) => s.status !== 'ended');
  const shown = active.length ? active.slice(0, 4) : sorted.slice(0, 1);
  const lines = [`# ${key}: working memory`, ''];
  if (git.branch) lines.push(`Branch: ${git.branch}`);
  lines.push(`Active sessions: ${active.length}`);
  if (shown.length) {
    lines.push('', active.length ? 'Sessions:' : 'Last session:');
    for (const s of shown) {
      lines.push(`- ${clip(s.title ?? s.name ?? s.id.slice(0, 8), 80)} (${s.status})`);
      if (s.lastPrompt) lines.push(`  last prompt: ${clip(s.lastPrompt, 120)}`);
    }
  }
  if (git.changed.length) {
    lines.push('', `Changed files (${git.changed.length}):`);
    for (const f of git.changed.slice(0, 15)) lines.push(`- ${f}`);
  }
  return (lines.join('\n') + '\n').slice(0, MAX_STATE_CHARS);
}
