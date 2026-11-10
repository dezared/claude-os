// Keeps the dev kit (repo CLAUDE.md, .claude/rules, skills, agents) out of product sessions,
// whose cwd lies inside the repo and would otherwise inherit it as a parent.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import type { Paths } from '../context.ts';

export type IsolationSettings = { claudeMdExcludes: string[]; skillOverrides: Record<string, 'off'>; permissions: { deny: string[] } };

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function within(dir: string, p: string): boolean {
  const rel = relative(real(dir), real(p));
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function names(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function isProductCwd(paths: Pick<Paths, 'root' | 'service' | 'setup'>, cwd: string): boolean {
  return [paths.root, paths.service, paths.setup].some((dir) => within(dir, cwd));
}

// Names are read at call time, so a new dev skill or agent is excluded without a code change.
export function devIsolation(repo: string): IsolationSettings {
  const r = real(repo);
  const skills = join(r, '.claude', 'skills');
  const agents = join(r, '.claude', 'agents');
  const skillNames = names(skills).filter((n) => statSync(join(skills, n), { throwIfNoEntry: false })?.isDirectory());
  const agentNames = names(agents).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
  return {
    claudeMdExcludes: [`${r}/CLAUDE.md`, `${r}/CLAUDE.local.md`, `${r}/.claude/rules/**`],
    skillOverrides: Object.fromEntries(skillNames.map((n) => [n, 'off' as const])),
    permissions: { deny: agentNames.map((n) => `Agent(${n})`) },
  };
}

export function withDevIsolation(paths: Pick<Paths, 'repo' | 'root' | 'service' | 'setup'>, cwd: string, settings?: Settings): Settings | undefined {
  if (!isProductCwd(paths, cwd)) return settings;
  const iso = devIsolation(paths.repo);
  return {
    ...settings,
    claudeMdExcludes: [...(settings?.claudeMdExcludes ?? []), ...iso.claudeMdExcludes],
    skillOverrides: { ...settings?.skillOverrides, ...iso.skillOverrides },
    permissions: { ...settings?.permissions, deny: [...(settings?.permissions?.deny ?? []), ...iso.permissions.deny] },
  };
}
