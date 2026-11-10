import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx, MemoryApi } from '../context.ts';
import { lintNote, type LintCtx } from './lint.ts';
import type { Store } from './store.ts';
import { safely } from './util.ts';
import { isWikiManaged } from './wikiManaged.ts';

// Rejects malformed notes written by Claude OS sessions; null lets the tool run as it would without the guard.
export type GuardDecision = { decision: 'allow' | 'deny'; reason: string } | null;

// A tab rewriting a wiki migration batch: inputs are absolute paths, batchDir is inside the vault.
export interface GuardMigration {
  tab(tabId: string): { key: string; batchDir: string; inputs: string[] } | null;
  lintCtx(tabId: string, path: string): LintCtx;
  // The project whose rewriting or ready run takes this note as an input; null otherwise.
  inputOf(path: string): string | null;
}

const ALLOW = { decision: 'allow', reason: 'wiki migration batch' } as const;

type Edit = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };

// The text an Edit/MultiEdit leaves in the file; null when an old_string is absent (the tool itself will fail).
function applyEdits(text: string, edits: Edit[]): string | null {
  let out = text;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    const at = out.indexOf(e.old_string);
    if (at < 0) return null;
    out = e.replace_all === true ? out.split(e.old_string).join(e.new_string) : out.slice(0, at) + e.new_string + out.slice(at + e.old_string.length);
  }
  return out;
}

function resultingText(path: string, tool: string, input: Record<string, unknown>): string | null {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : null;
  const edits = tool === 'Edit' ? [input as Edit] : tool === 'MultiEdit' && Array.isArray(input.edits) ? (input.edits as Edit[]) : null;
  return edits && applyEdits(readFileSync(path, 'utf8'), edits);
}

// Vault-relative parts: a server-generated file, a project note, or anything else.
function kindOf(parts: string[]): 'generated' | 'note' | null {
  if (parts[0] === '_index' || parts[0] === '_log') return 'generated';
  if (parts[0] !== 'projects' || parts.length !== 3) return null;
  if (parts[2] === 'MEMORY.md') return 'generated';
  return /\.md$/i.test(parts[2]) ? 'note' : null;
}

const rejectsOf = (path: string, text: string, lintCtx: LintCtx) => lintNote(basename(path), text, lintCtx).issues.filter((i) => i.reject);
const denyAll = (rejects: { message: string }[]) => ({ decision: 'deny', reason: rejects.map((i) => i.message).join('\n') }) as const;

// The note an out/ write leaves behind must pass lint with the batch's context.
function batchNote(lintCtx: LintCtx, path: string, tool: string, input: Record<string, unknown>): GuardDecision {
  const text = resultingText(path, tool, input);
  if (text === null) return null;
  const rejects = rejectsOf(path, text, lintCtx);
  return rejects.length ? denyAll(rejects) : ALLOW;
}

type Call = { vault: string; tool: string; input: Record<string, unknown> };

// A batch tab reads its inputs, its project and its batch dir, and writes only out/*.md and map.json.
function batchDecision(m: GuardMigration, tabId: string, path: string, { vault, tool, input }: Call): GuardDecision {
  const batch = m.tab(tabId)!;
  const dir = resolve(batch.batchDir);
  const inside = (base: string) => path === base || path.startsWith(base + sep);
  if (tool === 'Read') {
    if (batch.inputs.includes(path) || inside(dir) || inside(join(vault, 'projects', batch.key))) return ALLOW;
    return { decision: 'deny', reason: `during the wiki migration read only the notes of ${batch.key} and ${dir}` };
  }
  if (dirname(path) === join(dir, 'out') && /\.md$/i.test(path)) return batchNote(m.lintCtx(tabId, path), path, tool, input);
  if (path === join(dir, 'map.json')) return ALLOW;
  return { decision: 'deny', reason: `during the wiki migration write only to ${dir}` };
}

export function createGuard(ctx: Ctx, store: Store, migration?: GuardMigration) {
  const vault = resolve(ctx.paths.vault);

  // The path relative to the vault, the real one or the symlink, or null outside it.
  function inVault(path: string): string | null {
    for (const base of [vault, safely(() => realpathSync(vault), vault)]) {
      const rel = relative(base, path);
      if (rel && rel.split(sep)[0] !== '..' && !isAbsolute(rel)) return rel;
    }
    return null;
  }

  // Before its wiki migration a project keeps its old notes: an edit or a rewrite of one is denied only for a reject
  // it adds. A new note is checked fully.
  function noteDecision(path: string, tool: string, input: Record<string, unknown>, managed: boolean): GuardDecision {
    const text = resultingText(path, tool, input);
    if (text === null) return null;
    const lintCtx = store.lintCtx(path);
    const before = managed ? null : safely(() => readFileSync(path, 'utf8'), null);
    const had = new Set(before === null ? [] : rejectsOf(path, before, lintCtx).map((i) => i.code));
    const rejects = rejectsOf(path, text, lintCtx).filter((i) => !had.has(i.code));
    return rejects.length ? denyAll(rejects) : null;
  }

  // MEMORY.md is generated only in a managed project; _index and _log always.
  function writeDecision(parts: string[], tool: string, input: Record<string, unknown>): GuardDecision {
    const kind = kindOf(parts);
    const managed = parts[0] !== 'projects' || isWikiManaged(ctx.paths, parts[1]);
    if (kind === 'generated' && managed) return { decision: 'deny', reason: `${parts.join('/')} is generated by Claude OS; write or edit the note instead` };
    if (kind !== 'note') return null;
    const path = join(vault, ...parts);
    const key = migration?.inputOf(path);
    if (key) return { decision: 'deny', reason: `${parts.join('/')} is being rewritten by the wiki migration of ${key}: put the change in a new note, or edit this one after the migration is applied or discarded` };
    return noteDecision(path, tool, input, managed);
  }

  function decide(tabId: string, cwd: string, tool: string, input: Record<string, unknown>): GuardDecision {
    if (typeof input.file_path !== 'string') return null;
    const rel = inVault(resolve(cwd, input.file_path));
    if (!rel) return null;
    if (migration?.tab(tabId)) return batchDecision(migration, tabId, join(vault, rel), { vault, tool, input });
    return tool === 'Read' ? null : writeDecision(rel.split(sep), tool, input);
  }

  return {
    // A guard that fails must never block a write. The tab id selects the wiki migration rules.
    check: (tabId: string, cwd: string, tool: string, input: Record<string, unknown>): GuardDecision =>
      safely(() => decide(tabId, cwd, tool, input), null),
  };
}

// The SDK PreToolUse hook every Claude OS session registers; the cwd comes from the CLI, so a worktree session resolves right.
export function noteGuardHooks(memory: MemoryApi, tabId: string): Options['hooks'] {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const d = safely(() => memory.guardTool(tabId, input.cwd, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>), null);
    return d ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } } : {};
  };
  return { PreToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit', hooks: [hook] }] };
}
