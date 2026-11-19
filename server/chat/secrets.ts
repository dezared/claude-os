// Values the user typed after /secret: one file per scope under data/secrets/, readable by the server user only, never
// logged or returned. A project's secrets are its own: the scope is the project key, or the folder of a tab outside any project.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { SECRET_NAME, secretLines, secretMarker, type SecretRequest } from '../../shared/secrets.ts';
import type { Ctx } from '../context.ts';
import { httpError } from '../memory/util.ts';

type Values = Record<string, string>;

export const secretsDir = (ctx: Pick<Ctx, 'paths'>) => join(ctx.paths.data, 'secrets');
export const secretScope = (tab: { project: string | null; cwd: string }) => tab.project ?? tab.cwd;

// A secret becomes env of the scope's sessions: it must not replace the env the server runs with, nor what steers the
// shell, node, the dynamic loader or the Claude CLI.
const RESERVED = /^(?:PATH|HOME|USER|SHELL)$|^(?:NODE_|ANTHROPIC_|CLAUDE_|npm_|LD_|DYLD_)/;
const reserved = (name: string) => RESERVED.test(name) || name in process.env;

// The file name is a hash of the scope: the scope may be a path, and the name must not tell which project it is.
const scopeFile = (dir: string, scope: string) => join(dir, `${createHash('sha256').update(scope).digest('hex').slice(0, 32)}.json`);

function read(dir: string, scope: string): Values {
  try {
    return JSON.parse(readFileSync(scopeFile(dir, scope), 'utf8')) as Values;
  } catch {
    return {}; // none saved yet
  }
}

// Through a temporary file created 0600: the values are never on disk with wider rights, and a crash leaves the old file.
function write(dir: string, scope: string, values: Values): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = scopeFile(dir, scope);
  if (Object.keys(values).length === 0) return rmSync(file, { force: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(values, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The single data/secrets.json of the first version becomes one file per scope. */
export function migrateSecrets(ctx: Pick<Ctx, 'paths'>): void {
  const old = join(ctx.paths.data, 'secrets.json');
  if (!existsSync(old)) return;
  for (const [scope, values] of Object.entries(JSON.parse(readFileSync(old, 'utf8')) as Record<string, Values>)) write(secretsDir(ctx), scope, values);
  rmSync(old);
}

/** Stores the value and returns its name: the given one, or the next free SECRET_<n>. The same name replaces the value. */
export function saveSecret(dir: string, scope: string, name: string | null, value: string): string {
  const own = read(dir, scope);
  let saved = name;
  for (let n = 1; !saved; n++) if (!(`SECRET_${n}` in own)) saved = `SECRET_${n}`;
  write(dir, scope, { ...own, [saved]: value });
  return saved;
}

export const secretNames = (dir: string, scope: string) => Object.keys(read(dir, scope)).sort();
export const secretValue = (dir: string, scope: string, name: string): string | undefined => read(dir, scope)[name];
/** For the env of a new session of the scope: $NAME in its Bash. A reserved name, saved before names were checked, is left out. */
export const secretEnv = (dir: string, scope: string): Values => Object.fromEntries(Object.entries(read(dir, scope)).filter(([name]) => !reserved(name)));

/**
 * Keeps Read and Bash out of the store. `//` is the absolute-path anchor of Read rules; one slash would mean "relative to
 * the settings source". Bash rules match the command text, so they catch the usual paths, not every way to spell one.
 */
export function secretRules(ctx: Pick<Ctx, 'paths'>): string[] {
  const dir = join(realpathSync(ctx.paths.data), 'secrets');
  return [`Read(/${dir}/**)`, `Bash(*${dir}*)`, 'Bash(*data/secrets*)'];
}

/** A session never writes data/ and never opens the secrets; the values the user hid with /secret are $NAME in its Bash. */
export function sessionDataOptions(ctx: Pick<Ctx, 'paths'>, tab: { project: string | null; cwd: string }): Pick<Options, 'disallowedTools' | 'env'> {
  const env = secretEnv(secretsDir(ctx), secretScope(tab));
  // Write(path) rules never match: Edit(path) covers every file-writing tool.
  return {
    disallowedTools: [`Edit(/${realpathSync(ctx.paths.data)}/**)`, ...secretRules(ctx)],
    ...(Object.keys(env).length ? { env: { ...process.env, ...env } } : {}),
  };
}

export function deleteSecret(dir: string, scope: string, name: string): boolean {
  const own = read(dir, scope);
  if (!(name in own)) return false;
  const { [name]: _gone, ...rest } = own;
  write(dir, scope, rest);
  return true;
}

function requestedName(body: Partial<SecretRequest> | null): string | null {
  const name = typeof body?.name === 'string' && body.name ? body.name : null;
  if (name && !SECRET_NAME.test(name)) throw httpError(400, 'A secret name is uppercase letters, digits and _', 'badSecretName');
  if (name && reserved(name)) throw httpError(400, `${name} is an environment variable of Claude OS or the system: choose another name`, 'reservedSecretName', { name });
  return name;
}

type SecretCtx = Pick<Ctx, 'paths' | 'audit' | 'chat' | 'settings'>;

/** POST /api/tabs/:id/secret: stores the value, then the tab's conversation gets the marker in its place. */
export function saveTabSecret(ctx: SecretCtx, tabId: string, body: Partial<SecretRequest> | null): { name: string } | { names: string[] } {
  if (tabId === ctx.settings?.setup().tabId) throw httpError(400, 'The setup tab keeps no secrets: save it in a project tab', 'secretInSetup');
  if (typeof body?.text === 'string') return sendWithSecrets(ctx, tabId, body.text, body.attachments);
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!value) throw httpError(400, 'Empty secret', 'emptySecret');
  const name = requestedName(body);
  const chat = ctx.chat!; // registered after the chat
  const scope = secretScope(chat.tabInfo(tabId));
  const saved = saveSecret(secretsDir(ctx), scope, name, value);
  ctx.audit('secret.save', scope, saved);
  chat.get(tabId).send({ text: secretMarker(saved) });
  return { name: saved };
}

/**
 * A message with /secret lines: every line is checked before any is stored, each value is stored and its line becomes
 * the marker, and the message goes out as one turn with the rest as typed.
 */
function sendWithSecrets(ctx: SecretCtx, tabId: string, text: string, attachments: SecretRequest['attachments']): { names: string[] } {
  const lines = secretLines(text);
  if (lines.length === 0 || lines.some((l) => !l.value)) throw httpError(400, 'Empty secret', 'emptySecret');
  for (const line of lines) requestedName(line);
  const chat = ctx.chat!; // registered after the chat
  const scope = secretScope(chat.tabInfo(tabId));
  const names: string[] = [];
  let message = '';
  let at = 0;
  for (const line of lines) {
    const saved = saveSecret(secretsDir(ctx), scope, line.name, line.value);
    ctx.audit('secret.save', scope, saved);
    names.push(saved);
    message += text.slice(at, line.start) + secretMarker(saved);
    at = line.end;
  }
  chat.get(tabId).send({ text: (message + text.slice(at)).trim(), ...(attachments?.length ? { attachments } : {}) });
  return { names };
}

export function registerSecrets(ctx: Ctx): void {
  migrateSecrets(ctx);
  ctx.app.post<{ Params: { id: string }; Body: SecretRequest | null }>('/api/tabs/:id/secret', async (req) => saveTabSecret(ctx, req.params.id, req.body));
}
