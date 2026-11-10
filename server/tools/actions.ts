import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { ActionDef, TerminalPreview } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely, sha256, wslDistro } from '../memory/util.ts';
import type { Approvals } from './approvals.ts';
import { platformKind, resumeArgv, shellArgv } from './platform.ts';
import { readJson } from './shared.ts';

const run = promisify(execFile);
const MAX_OUTPUT = 64 * 1024;

// `;` would start a new wt.exe command, `%`, `^` and quotes mean something on the Windows side. Letters of any alphabet stay.
const SAFE_PATH = /^\/[\p{L}\p{N}_\-./ +@,=~()[\]]*$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.length > 1024 || !SAFE_PATH.test(cwd) || cwd.split('/').includes('..')) throw httpError(400, 'bad cwd');
  if (!safely(() => statSync(cwd).isDirectory(), false)) throw httpError(400, 'cwd is not a directory');
  return cwd;
}

export function validatePath(path: unknown): string {
  if (typeof path !== 'string' || path.length > 1024 || !SAFE_PATH.test(path) || path.split('/').includes('..')) throw httpError(400, 'bad path');
  if (!safely(() => statSync(path).isFile(), false)) throw httpError(400, 'not a file');
  return path;
}

export function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw httpError(400, 'bad sessionId');
  return id;
}

export interface RunBody {
  project?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
}

interface Target {
  root: string | null;
  cwd: string | null;
  sessionId: string | null;
}

interface UserAction {
  id: string;
  title: string;
  command: string;
  cwd?: string | null;
  confirm?: boolean;
}

interface Builtin {
  id: string;
  title: string;
  command: string;
  argv(t: Target & { cwd: string }): [string, string[]];
}

const commandLine = ({ bin, args }: { bin: string; args: string[] }) => [bin, ...args].join(' ');

export function launch(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.once('error', (err) => reject(httpError(500, `failed to start ${basename(bin)}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function createActions(ctx: Ctx, approvals: Approvals) {
  const file = join(ctx.paths.config, 'actions.json');

  function builtins(): Builtin[] {
    const kind = platformKind();
    return [
      {
        id: 'builtin:shell',
        title: 'Terminal',
        command: kind === 'wsl' ? `wt.exe wsl.exe -d ${wslDistro()} --cd <cwd>` : 'wt.exe -d <cwd>',
        argv: (t) => {
          const { bin, args } = shellArgv(kind, t.cwd);
          return [bin, args];
        },
      },
      {
        id: 'builtin:terminal',
        title: 'claude --resume',
        // The flag is decided per run, see terminalPreview for one session's exact text.
        command: `${commandLine(resumeArgv(kind, '<cwd>', 'claude', '<sessionId>'))} [--fork-session: when the session has a running process or a tab]`,
        argv: (t) => {
          // Two processes on one session write one journal: a session in use gets a copy of its own.
          // So does one with a tab, even an idle one: the terminal must never lock the tab out of its own session.
          const hasTab = t.sessionId !== null && (ctx.chat?.sessionTabs(t.sessionId) ?? []).some((tab) => tab.kind !== 'readonly');
          const fork = hasTab || (t.sessionId !== null && !!ctx.chat?.sessionHolder(t.sessionId));
          const { bin, args } = resumeArgv(kind, t.cwd, ctx.paths.claudeBin, t.sessionId, fork);
          return [bin, args];
        },
      },
    ];
  }

  function userActions(): UserAction[] {
    const raw = readJson<unknown>(file);
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is UserAction =>
      a && typeof a.id === 'string' && !a.id.startsWith('builtin:') && typeof a.title === 'string' && typeof a.command === 'string');
  }

  function list(): ActionDef[] {
    const fixed: ActionDef[] = builtins().map((b) => ({
      id: b.id, title: b.title, command: b.command, cwd: '{cwd}', confirm: false, builtin: true, approved: true,
    }));
    const user: ActionDef[] = userActions().map((a) => ({
      id: a.id, title: a.title, command: a.command, cwd: a.cwd ?? null, confirm: a.confirm === true, builtin: false, approved: approvals.isApproved(a.command),
    }));
    return [...fixed, ...user];
  }

  function resolveTarget(body: RunBody): Target {
    let root: string | null = null;
    if (body.project !== undefined && body.project !== null) {
      root = safely(() => ctx.journal.listProjects(true), []).find((p) => p.key === body.project)?.root ?? null;
      if (!root) throw httpError(404, 'unknown project');
      root = validateCwd(root);
    }
    const cwd = body.cwd !== undefined && body.cwd !== null ? validateCwd(body.cwd) : root;
    const sessionId = body.sessionId !== undefined && body.sessionId !== null ? validateSessionId(body.sessionId) : null;
    return { root, cwd, sessionId };
  }

  /** What the terminal button would run for this session right now. The run asks again: this can go out of date. */
  function terminalPreview(body: RunBody): TerminalPreview {
    const target = resolveTarget(body);
    if (!target.cwd) throw httpError(400, 'cwd or project is required');
    const [bin, args] = builtins().find((b) => b.id === 'builtin:terminal')!.argv({ ...target, cwd: target.cwd });
    const holder = target.sessionId ? ctx.chat?.sessionHolder(target.sessionId)?.where ?? null : null;
    return { command: commandLine({ bin, args }), fork: args.includes('--fork-session'), holder };
  }

  async function runAction(id: string, body: RunBody): Promise<{ ok: true; output: string; fork?: boolean; command?: string }> {
    const target = resolveTarget(body);
    const builtin = builtins().find((b) => b.id === id);
    if (builtin) {
      if (!target.cwd) throw httpError(400, 'cwd or project is required');
      const [bin, args] = builtin.argv({ ...target, cwd: target.cwd });
      await launch(bin, args);
      ctx.audit('action.run', id, target.cwd);
      return { ok: true, output: '', ...(id === 'builtin:terminal' && target.sessionId ? { fork: args.includes('--fork-session'), command: commandLine({ bin, args }) } : {}) };
    }

    const action = userActions().find((a) => a.id === id);
    if (!action) throw httpError(404, 'action not found');
    if (!approvals.isApproved(action.command)) {
      throw Object.assign(httpError(409, 'pending approval'), { command: action.command, sha256: sha256(action.command) });
    }
    const cwd = action.cwd ? expandCwd(action.cwd, target) : target.cwd ?? ctx.paths.repo;
    // Values reach the approved text as $1 and $2 only: they never become part of the script.
    const args = ['-c', action.command, 'claude-os-action', target.cwd ?? '', target.sessionId ?? ''];
    ctx.audit('action.run', id, action.command);
    try {
      const { stdout, stderr } = await run('bash', args, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
      return { ok: true, output: (stdout + stderr).slice(0, MAX_OUTPUT) };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      throw httpError(422, `${e.message.split('\n')[0]}\n${(e.stderr ?? '') + (e.stdout ?? '')}`.slice(0, MAX_OUTPUT));
    }
  }

  function expandCwd(template: string, target: Target): string {
    const expanded = template.replaceAll('{project}', target.root ?? target.cwd ?? '').replaceAll('{cwd}', target.cwd ?? target.root ?? '');
    return validateCwd(expanded);
  }

  // `command`, when sent, pins what the user actually saw: the config may have changed since the list was fetched.
  function approve(id: string, seen?: unknown): ActionDef {
    if (id.startsWith('builtin:')) throw httpError(400, 'built-in actions need no approval');
    const action = userActions().find((a) => a.id === id);
    if (!action) throw httpError(404, 'action not found');
    if (seen !== undefined && seen !== action.command) throw httpError(409, 'the command changed: review it again');
    approvals.approve(action.command, `action:${id}`);
    ctx.invalidate('actions');
    return list().find((a) => a.id === id) as ActionDef;
  }

  return { list, runAction, approve, terminalPreview };
}
