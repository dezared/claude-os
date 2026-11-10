// The two files the kit shares with the user: `.claude/settings.json` and `.gitignore`.
// The kit adds its own entries and later removes exactly those; the user's keys, entries and order stay as they were.
import type { KitAnswers, KitDetection, KitLock } from '../../shared/projectKit.ts';

type Obj = Record<string, unknown>;
type Added = KitLock['settings'];

/** What the kit wants in the settings file, and which file that is. */
export interface KitSettings { file: string; hooks: Record<string, unknown[]>; allow: string[]; deny: string[]; ask: string[] }

const LISTS = ['allow', 'deny', 'ask'] as const;
// Kit hook entries are recognised by this folder in their command.
const KIT_DIR = '.claude/kit/';
const GATE = 'node .claude/kit/gate.mjs';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const hook = (name: string, timeout?: number) => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/kit/hooks/${name}.mjs"`, ...(timeout ? { timeout } : {}) });

/** The kit's hooks and permissions for a project; hooks go to the local settings file when the user chose that scope. */
export function kitSettings(d: KitDetection, answers: KitAnswers): KitSettings {
  const commands = [...d.commands.map((c) => `Bash(${c.run}*)`), `Bash(${GATE}*)`, 'Bash(node .claude/kit/size.mjs --tighten)'];
  return {
    file: answers.scope === 'local' ? '.claude/settings.local.json' : '.claude/settings.json',
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write', hooks: [hook('protect-files')] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [hook('after-edit', 30)] }],
      Stop: [{ hooks: [hook('stop-gate', 300)] }],
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [hook('briefing')] }],
    },
    allow: [...new Set([...commands, 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)'])],
    deny: ['Edit(./.claude/kit/**)'],
    ask: ['Bash(git push*)'],
  };
}

function shapeProblem(json: unknown): string | null {
  if (!isObj(json)) return 'is not a JSON object';
  if (json.hooks !== undefined && (!isObj(json.hooks) || !Object.values(json.hooks).every(Array.isArray))) return 'has hooks that are not lists';
  const perms = json.permissions;
  if (perms === undefined) return null;
  if (!isObj(perms) || LISTS.some((k) => perms[k] !== undefined && !Array.isArray(perms[k]))) return 'has permissions that are not lists';
  return null;
}

function parse(current: string | null, file: string): Obj | string {
  if (current === null) return {};
  let json: unknown;
  try {
    json = JSON.parse(current);
  } catch (err) {
    return `${file} is not valid JSON (${(err as Error).message}); fix it and plan again`;
  }
  const problem = shapeProblem(json);
  return problem ? `${file} ${problem}; fix it and plan again` : (json as Obj);
}

const commandsOf = (entry: unknown): string[] => (isObj(entry) && Array.isArray(entry.hooks) ? entry.hooks.flatMap((h) => (isObj(h) && typeof h.command === 'string' ? [h.command] : [])) : []);
const isKitEntry = (entry: unknown) => commandsOf(entry).some((c) => c.includes(KIT_DIR));

// The kit's entries take the place of the first old kit entry; without one they go after the user's.
function placeEntries(list: unknown[], kit: unknown[]): unknown[] {
  const first = list.findIndex(isKitEntry);
  const user = list.filter((e) => !isKitEntry(e));
  const at = first < 0 ? user.length : list.slice(0, first).filter((e) => !isKitEntry(e)).length;
  return [...user.slice(0, at), ...kit, ...user.slice(at)];
}

function mergeHooks(hooks: Obj, kit: Record<string, unknown[]>): Obj {
  const out: Obj = {};
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(kit)])) {
    const list = placeEntries((hooks[event] as unknown[] | undefined) ?? [], kit[event] ?? []);
    if (list.length || event in hooks) out[event] = list;
  }
  return out;
}

// Appends what is absent; drops strings the kit added before and no longer wants; claims only what the kit put there.
function mergeList(current: unknown[], want: string[], prev: string[]): { list: unknown[]; added: string[] } {
  const kept = current.filter((s) => !(typeof s === 'string' && prev.includes(s) && !want.includes(s)));
  const fresh = want.filter((s) => !kept.includes(s));
  return { list: [...kept, ...fresh], added: want.filter((s) => fresh.includes(s) || (prev.includes(s) && kept.includes(s))) };
}

const indentOf = (text: string | null) => /^([ \t]+)"/m.exec(text ?? '')?.[1] ?? 2;

function mergePermissions(perms: Obj, kit: KitSettings, prev: Added | null): { perms: Obj; added: Pick<Added, 'allow' | 'deny' | 'ask'> } {
  const out: Obj = { ...perms };
  const added = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
  for (const key of LISTS) {
    const merged = mergeList((perms[key] as unknown[] | undefined) ?? [], kit[key], prev?.[key] ?? []);
    if (merged.list.length || key in perms) out[key] = merged.list;
    added[key] = merged.added;
  }
  return { perms: out, added };
}

/** Merges the kit into a settings file; an unreadable file is reported, never rewritten. */
export function mergeSettings(current: string | null, kit: KitSettings, prev: Added | null): { content: string; added: Added } | { invalid: string } {
  const json = parse(current, kit.file);
  if (typeof json === 'string') return { invalid: json };
  const merged = mergePermissions((json.permissions as Obj | undefined) ?? {}, kit, prev);
  const out: Obj = { ...json, permissions: merged.perms, hooks: mergeHooks((json.hooks as Obj | undefined) ?? {}, kit.hooks) };
  const added: Added = { file: kit.file, ...merged.added, hooks: Object.values(kit.hooks).flat().flatMap(commandsOf) };
  if (current !== null && JSON.stringify(out) === JSON.stringify(json)) return { content: current, added };
  return { content: `${JSON.stringify(out, null, indentOf(current))}\n`, added };
}

// Removes the kit's strings; a list the removal emptied goes too, an empty list the user wrote stays.
function withoutStrings(perms: Obj, added: Added): Obj {
  const out: Obj = { ...perms };
  for (const key of LISTS) {
    const list = perms[key];
    if (!Array.isArray(list) || !list.length) continue;
    const left = list.filter((s) => !added[key].includes(s));
    if (left.length) out[key] = left;
    else delete out[key];
  }
  return out;
}

function withoutHooks(hooks: Obj, commands: string[]): Obj {
  const out: Obj = {};
  for (const [event, list] of Object.entries(hooks)) {
    const entries = (list as unknown[]).flatMap((entry) => {
      if (!isObj(entry) || !Array.isArray(entry.hooks)) return [entry];
      const left = entry.hooks.filter((h) => !(isObj(h) && commands.includes(h.command as string)));
      if (left.length === entry.hooks.length) return [entry];
      return left.length ? [{ ...entry, hooks: left }] : [];
    });
    if (entries.length || !(list as unknown[]).length) out[event] = entries;
  }
  return out;
}

// Replaces an object key with what the strip left, or drops the key when nothing is left.
function strip(out: Obj, key: string, left: (value: Obj) => Obj): void {
  const value = out[key];
  if (!isObj(value) || !Object.keys(value).length) return;
  const rest = left(value);
  if (Object.keys(rest).length) out[key] = rest;
  else delete out[key];
}

/** Takes out exactly what the lock says the kit added; anything unreadable is left as it is. */
export function unmergeSettings(current: string, added: Added): string {
  const json = parse(current, added.file);
  if (typeof json === 'string') return current;
  const out: Obj = { ...json };
  strip(out, 'permissions', (perms) => withoutStrings(perms, added));
  strip(out, 'hooks', (hooks) => withoutHooks(hooks, added.hooks));
  return `${JSON.stringify(out, null, indentOf(current))}\n`;
}

const START = '# claude-os-kit:start';
const END = '# claude-os-kit:end';
const BLOCK = /# claude-os-kit:start\n[\s\S]*?# claude-os-kit:end\n?/;

/** The kit's block in `.gitignore`: replaced where it is, appended after a blank line when absent. */
export function mergeGitignore(current: string | null, docsDir: string): string {
  const block = [START, 'CLAUDE.local.md', '.claude/settings.local.json', `${docsDir}/handoff/`, END, ''].join('\n');
  const text = current ?? '';
  if (BLOCK.test(text)) return text.replace(BLOCK, block);
  if (!text) return block;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`;
}

export function unmergeGitignore(current: string): string {
  return current.replace(new RegExp(`(^|\\n)\\n?${BLOCK.source}`), '$1');
}
