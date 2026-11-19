// One Markdown file per card in vault/kanban, named by its id (OS-21.md), so Obsidian can open, edit and hand it on. The
// frontmatter is the card's fields, the body its description, `rank` its place on the board. Kanban+ only adds keys: a file
// from the built-in board reads as it is, and keys it does not know survive every write.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { httpError } from './fail.ts';
import { COLUMNS, DEFAULT_BOARDS, LEVELS, PRIORITIES, TYPES, defaultBoard, type Card, type Column, type KanbanBoard, type Level, type Priority, type CardType, type WrittenKey } from './types.ts';

export const CARD_FILE = /^([A-Z][A-Z0-9]{0,9})-(\d+)\.md$/;
export const BOARD_FILE = '_board.json'; // prefixes, counters and the boards: what no single card knows
const LAST_RESORT_RANK = 1e12; // a file made by hand has no rank: it stands after the others

export type Frontmatter = (text: string) => { data: Record<string, string>; body: string };

export interface Stored extends Card {
  rank: number;
  aliases: string[]; // ids this card had: a mention already sent keeps working
  extra: string; // frontmatter lines this code does not know: tags added in Obsidian survive a move
  unknownBoard?: string; // a board id the board file does not know: shown on the default board, kept in the file until a board is set
  rawLines?: Partial<Record<WrittenKey, string>>; // the lines of an asWritten field, written back as they are until the field is set
}

export interface BoardState {
  prefixes: Record<string, string>; // project key or GENERAL_BOARD
  counters: Record<string, number>; // the last number given, per prefix: a deleted card's id is not given again
  boards: KanbanBoard[];
}

export const publicCard = ({ rank: _r, aliases: _a, extra: _e, unknownBoard: _u, rawLines: _l, ...card }: Stored): Card => card;

/** Setting a field ends its hand-written value: from then on the board writes it. */
export function forgetWritten(card: Stored, key: WrittenKey): void {
  if (card.asWritten) delete card.asWritten[key];
  if (card.rawLines) delete card.rawLines[key];
}

// Write the temp file next to the target, hidden from the watcher and from Obsidian, then rename.
export function writeAtomic(path: string, text: string): void {
  const slash = path.lastIndexOf('/');
  const tmp = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const KNOWN_KEYS = new Set(['title', 'project', 'type', 'priority', 'column', 'rank', 'labels', 'estimate', 'assignee', 'level', 'agent', 'agent_tab', 'board', 'sessions', 'aliases', 'created', 'updated']);

const headOf = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? '';

// The head's lines grouped by the key they belong to: a list's items and a folded value go with their key.
function linesByKey(head: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    const key = /^([\w-]+):/.exec(line)?.[1];
    if (key) out.push([key, line]);
    else if (out.length) out[out.length - 1][1] += `\n${line}`;
  }
  return out;
}

const unknownLines = (head: string) => linesByKey(head).filter(([key]) => !KNOWN_KEYS.has(key)).map(([, lines]) => lines).join('\n');

// As written here (["a"]) or as Obsidian writes a list (one "  - a" per line); anything else is not a list this code reads.
function isListValue(lines: string): boolean {
  const inline = lines.slice(lines.indexOf(':') + 1).split('\n')[0].trim();
  if (!inline) return true;
  try {
    const parsed = JSON.parse(inline) as unknown;
    return Array.isArray(parsed) && parsed.every((a) => typeof a === 'string');
  } catch {
    return false;
  }
}

const UNDERSTOOD: Record<WrittenKey, (value: string, lines: string) => boolean> = {
  type: (v) => TYPES.includes(v as CardType),
  assignee: (v) => v === 'user',
  labels: (_v, lines) => isListValue(lines),
  estimate: (v) => Number.isFinite(Number(v)),
};

// Values of these keys written by hand that the board does not understand (a type it has no name for, a person, a
// label as plain text, "2h"): shown as they are and kept in the file word for word, not replaced by a default.
function handWritten(data: Record<string, string>, head: string): Pick<Stored, 'asWritten' | 'rawLines'> {
  const asWritten: Partial<Record<WrittenKey, string>> = {};
  const rawLines: Partial<Record<WrittenKey, string>> = {};
  for (const [key, lines] of linesByKey(head)) {
    if (!(key in UNDERSTOOD)) continue;
    const value = typeof data[key] === 'string' ? data[key] : lines.slice(lines.indexOf(':') + 1).trim();
    if (value.trim() === '' || UNDERSTOOD[key as WrittenKey](value, lines)) continue;
    asWritten[key as WrittenKey] = value;
    rawLines[key as WrittenKey] = lines;
  }
  return Object.keys(asWritten).length ? { asWritten, rawLines } : {};
}

// As written here (["a"]) or as Obsidian rewrites a list property (one "  - a" per line).
function listOf(head: string, key: string): string[] {
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return [];
  const inline = lines[at].slice(key.length + 1).trim();
  if (inline) {
    try {
      return (JSON.parse(inline) as unknown[]).filter((a): a is string => typeof a === 'string');
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;
    out.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

const timeOf = (value: string | undefined, fallback: number) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
};
const oneOf = <T extends string>(list: readonly T[], value: string | undefined, fallback: T): T => (list.includes(value as T) ? value as T : fallback);

function optional(data: Record<string, string>, head: string): Partial<Card> {
  const sessions = listOf(head, 'sessions');
  const estimate = Number(data.estimate);
  return {
    ...(data.estimate && Number.isFinite(estimate) ? { estimate } : {}),
    ...(data.assignee === 'user' ? { assignee: 'user' as const } : {}),
    ...(LEVELS.includes(data.level as Level) ? { level: data.level as Level } : {}),
    ...(data.agent ? { agent: data.agent } : {}),
    ...(data.agent_tab ? { agentTab: data.agent_tab } : {}),
    ...(sessions.length ? { sessions } : {}),
  };
}

export function readCard(dir: string, name: string, frontmatter: Frontmatter): Stored {
  const path = join(dir, name);
  const text = readFileSync(path, 'utf8');
  const { data, body } = frontmatter(text);
  const head = headOf(text);
  const id = name.slice(0, -3);
  const mtime = statSync(path).mtimeMs;
  const rank = Number(data.rank);
  const firstLine = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return {
    id,
    title: data.title || firstLine || id,
    description: body,
    project: data.project || null,
    type: oneOf<CardType>(TYPES, data.type, 'task'),
    priority: oneOf<Priority>(PRIORITIES, data.priority, 'normal'),
    column: oneOf<Column>(COLUMNS, data.column, 'backlog'),
    board: data.board || defaultBoard(oneOf<CardType>(TYPES, data.type, 'task')),
    labels: listOf(head, 'labels'),
    ...optional(data, head),
    comments: 0,
    path,
    created: timeOf(data.created, mtime),
    updated: timeOf(data.updated, mtime),
    rank: head && Number.isFinite(rank) && data.rank ? rank : LAST_RESORT_RANK + Number(CARD_FILE.exec(name)?.[2] ?? 0),
    aliases: listOf(head, 'aliases'),
    extra: unknownLines(head),
    ...handWritten(data, head),
  };
}

const listOrNull = (list: string[] | undefined) => (list?.length ? list : null);

export function cardText(card: Stored): string {
  const meta: Record<string, unknown> = {
    title: card.title,
    project: card.project,
    type: card.type === 'task' ? null : card.type, // a file from before Kanban+ stays as it was until a type is chosen
    priority: card.priority,
    column: card.column,
    rank: card.rank,
    labels: listOrNull(card.labels),
    estimate: card.estimate,
    assignee: card.assignee,
    level: card.level,
    agent: card.agent,
    agent_tab: card.agentTab,
    board: card.unknownBoard ?? card.board,
    sessions: listOrNull(card.sessions),
    aliases: listOrNull(card.aliases),
    created: new Date(card.created).toISOString(),
    updated: new Date(card.updated).toISOString(),
  };
  const head = Object.entries(meta).flatMap(([k, v]) => {
    const raw = card.rawLines?.[k as WrittenKey];
    if (raw !== undefined) return [raw];
    return v === null || v === undefined ? [] : [`${k}: ${JSON.stringify(v)}`];
  });
  return `---\n${head.join('\n')}${card.extra ? `\n${card.extra}` : ''}\n---\n${card.description}`;
}

export function loadCards(dir: string, frontmatter: Frontmatter): Stored[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && CARD_FILE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  return names.map((name) => readCard(dir, name, frontmatter)).sort((a, b) => a.rank - b.rank || a.created - b.created);
}

const defaults = (): KanbanBoard[] => DEFAULT_BOARDS.map((id) => ({ id }));

export function readBoard(dir: string): BoardState {
  let text: string;
  try {
    text = readFileSync(join(dir, BOARD_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { prefixes: {}, counters: {}, boards: defaults() };
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<BoardState>;
    return { prefixes: parsed.prefixes ?? {}, counters: parsed.counters ?? {}, boards: Array.isArray(parsed.boards) ? parsed.boards : defaults() };
  } catch {
    // A damaged file is refused, not replaced: the next write would give out ids already taken.
    throw httpError(500, `the board file is damaged: ${join(dir, BOARD_FILE)}`);
  }
}

export function writeBoard(dir: string, state: BoardState): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, BOARD_FILE), JSON.stringify(state, null, 1));
}

/** Capitals in a row win (claudeOS: OS), then the first letters of the words (big-web: BW), then the start of the one word. */
export function derivePrefix(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const base = (/[A-Z]{2,}/.exec(name)?.[0] ?? (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3))).toUpperCase().slice(0, 6);
  const clean = /^[A-Z]/.test(base) ? base : `P${base}`;
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) if (!taken.has(`${clean}${n}`)) return `${clean}${n}`;
}
