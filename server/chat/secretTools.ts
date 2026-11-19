// The secrets of a work tab's project, used without being seen: names out, values only into a file of the project.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { fail, ok } from './dispatchTools.ts';
import { deleteSecret, secretNames, secretScope, secretsDir, secretValue } from './secrets.ts';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Plain when the value is one safe word. Single quotes keep everything else as it is, but end at a ' and a line.
// Double quotes then: dotenv readers turn \n into a line break there and unescape nothing else, so a " or a literal \n
// in such a value has no spelling at all.
function envValue(value: string): string | null {
  if (/^[\w@%+=:,./-]*$/.test(value)) return value;
  if (!/['\n]/.test(value)) return `'${value}'`;
  return /"|\\n/.test(value) ? null : `"${value.replace(/\n/g, '\\n')}"`;
}

/** Sets KEY in a dotenv file: the existing line is replaced in place, a new one is appended. False, and nothing written, when no quoting carries the value. */
export function upsertEnvLine(path: string, key: string, value: string): boolean {
  const quoted = envValue(value);
  if (quoted === null) return false;
  const line = `${key}=${quoted}`;
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = old ? old.replace(/\n$/, '').split('\n') : [];
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return true;
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 10_000 });

/** In a git repo, the project's own or one it sits inside, the written file must not be committed: added to .gitignore unless git already ignores it. */
export function keepOutOfGit(cwd: string, path: string): string {
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return 'not a git repository';
  }
  const rel = relative(cwd, path).split(sep).join('/');
  try {
    git(cwd, ['ls-files', '--error-unmatch', '--', rel]);
    return `warning: ${rel} is tracked by git, so the secret would be committed; tell the user`;
  } catch {
    // Not tracked: the usual case.
  }
  try {
    git(cwd, ['check-ignore', '-q', '--', rel]);
    return `${rel} is already git-ignored`;
  } catch (err) {
    if ((err as { status?: number }).status !== 1) return 'git did not answer: check that the file is git-ignored';
  }
  const ignore = join(cwd, '.gitignore');
  const old = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  appendFileSync(ignore, `${old && !old.endsWith('\n') ? '\n' : ''}/${rel}\n`);
  return `added /${rel} to .gitignore`;
}

function tabScope(ctx: Ctx, tabId: string): { cwd: string; scope: string } | null {
  const info = ctx.chat?.tabInfo(tabId);
  return info ? { cwd: info.cwd, scope: secretScope(info) } : null;
}

const NO_TAB = 'this tab is gone';

export const secretTools = (ctx: Ctx, tabId: string) => [
  tool('list_secrets', 'Names of the secrets the user saved for this project with /secret. Values are never shown.', {}, async () => {
    const tab = tabScope(ctx, tabId);
    return tab ? ok(secretNames(secretsDir(ctx), tab.scope)) : fail(NO_TAB);
  }, { annotations: { readOnlyHint: true } }),

  tool('write_secret', 'Write a secret the user saved with /secret into a dotenv file of the project as KEY=value, replacing an existing KEY line. In a git repository the file is added to .gitignore. Answer: where it went, never the value.', {
    name: z.string().describe('The secret name from list_secrets'),
    file: z.string().optional().describe('Path inside the project, relative to its folder. Defaults to .env'),
    key: z.string().optional().describe('The variable name in the file. Defaults to the secret name'),
  }, async ({ name, file, key }) => {
    const tab = tabScope(ctx, tabId);
    if (!tab) return fail(NO_TAB);
    const value = secretValue(secretsDir(ctx), tab.scope, name);
    if (value === undefined) return fail(`no secret ${name}: list_secrets gives the names`);
    const envKey = key ?? name;
    if (!ENV_KEY.test(envKey)) return fail(`invalid key ${JSON.stringify(envKey)}: letters, digits and _`);
    const path = resolve(tab.cwd, file ?? '.env');
    if (!path.startsWith(tab.cwd + sep)) return fail('the file must be inside the project folder');
    if (!upsertEnvLine(path, envKey, value)) return fail(`${name} cannot be written to a dotenv file: it has both a ' or a line break and a " or a literal \\n; tell the user`);
    ctx.audit('secret.write', path, envKey);
    return ok(`written ${envKey} to ${path}; ${keepOutOfGit(tab.cwd, path)}`);
  }),

  tool('delete_secret', 'Forget a secret the user saved for this project with /secret. Files it was written to keep it.', {
    name: z.string().describe('The secret name from list_secrets'),
  }, async ({ name }) => {
    const tab = tabScope(ctx, tabId);
    if (!tab) return fail(NO_TAB);
    if (!deleteSecret(secretsDir(ctx), tab.scope, name)) return fail(`no secret ${name}`);
    ctx.audit('secret.delete', tab.scope, name);
    return ok('deleted');
  }),
];
