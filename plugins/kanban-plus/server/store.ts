// The board's storage: what every operation shares. Every change is a synchronous read-change-rename, so concurrent
// requests take turns and a crash leaves the previous whole file.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commentCount, logEntry, moveLog, type Entry } from './activity.ts';
import { CARD_FILE, cardText, derivePrefix, loadCards, readBoard, writeAtomic, writeBoard, type BoardState, type Frontmatter, type Stored } from './cardFile.ts';
import { httpError } from './fail.ts';
import { migrateLegacy } from './legacy.ts';
import { GENERAL_BOARD, defaultBoard, type Actor } from './types.ts';

const GENERAL_PREFIX = 'TASK';

export interface BoardProject { key: string; name?: string }

export interface BoardOptions {
  projects: () => BoardProject[];
  frontmatter: Frontmatter;
  osProject?: () => string | null; // the Claude OS project: only its cards take a level
  legacy?: string; // data/kanban.json of the oldest boards, moved over once
  sessionOf?: (tab: string) => string | null; // the session a tab runs now, so a card taken in it knows that session from the start
}

export interface Board extends BoardOptions { dir: string }

export function write(b: Board, card: Stored): void {
  mkdirSync(b.dir, { recursive: true });
  writeAtomic(card.path, cardText(card));
}

// A board the board file does not know, an Obsidian edit or a removed one, is the default board of the card's type: the
// card stays in sight, its file keeps the id.
export function load(b: Board): Stored[] {
  if (b.legacy) migrateLegacy(b, b.legacy);
  const cards = loadCards(b.dir, b.frontmatter);
  const known = new Set(readBoard(b.dir).boards.map((x) => x.id));
  for (const card of cards) {
    card.comments = commentCount(b.dir, card.id);
    if (known.has(card.board)) continue;
    card.unknownBoard = card.board;
    card.board = defaultBoard(card.type);
  }
  return cards;
}

export function find(cards: Stored[], id: unknown): Stored {
  const wanted = String(id).toUpperCase();
  const card = cards.find((c) => c.id === wanted) ?? cards.find((c) => c.aliases.includes(String(id)) || c.aliases.includes(wanted));
  if (!card) throw httpError(404, `no card ${String(id)}`);
  return card;
}

export function project(b: Board, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !b.projects().some((p) => p.key === value)) throw httpError(400, `no project ${String(value)}`);
  return value;
}

/** The actor with the session its tab runs, written into the card's log. */
export function log(b: Board, id: string, actor: Actor, entry: Entry): void {
  const session = actor.session ?? (actor.tab ? b.sessionOf?.(actor.tab) : null);
  logEntry(b.dir, id, { ...actor, session }, entry);
}

// Assigned once and kept: the project's name may change later, its ids do not follow.
export function prefixOf(b: Board, state: BoardState, key: string | null): string {
  const slot = key ?? GENERAL_BOARD;
  if (state.prefixes[slot]) return state.prefixes[slot];
  const name = b.projects().find((p) => p.key === key)?.name ?? key;
  const prefix = key === null ? GENERAL_PREFIX : derivePrefix(name ?? '', new Set(Object.values(state.prefixes)));
  state.prefixes[slot] = prefix;
  return prefix;
}

const numbersOf = (cards: Stored[], prefix: string) => cards.flatMap((c) => {
  const m = CARD_FILE.exec(`${c.id}.md`);
  return m && m[1] === prefix ? [Number(m[2])] : [];
});

export function nextId(b: Board, state: BoardState, cards: Stored[], key: string | null): string {
  const prefix = prefixOf(b, state, key);
  const number = Math.max(state.counters[prefix] ?? 0, ...numbersOf(cards, prefix)) + 1;
  state.counters[prefix] = number;
  return `${prefix}-${number}`;
}

/** Each project's prefix: the one it has, or the one it would get. Nothing is saved by looking. */
export function prefixes(b: Board): Record<string, string> {
  if (b.legacy) migrateLegacy(b, b.legacy);
  const out = { ...readBoard(b.dir).prefixes };
  out[GENERAL_BOARD] ??= GENERAL_PREFIX;
  const taken = new Set(Object.values(out));
  for (const p of b.projects()) {
    if (out[p.key]) continue;
    out[p.key] = derivePrefix(p.name ?? p.key, taken);
    taken.add(out[p.key]);
  }
  return out;
}

/** A new id for the card; the old one stays as an alias, and the log goes along. */
export function rekey(b: Board, card: Stored, id: string): void {
  const old = card.path;
  if (!card.aliases.includes(card.id)) card.aliases = [...card.aliases, card.id];
  moveLog(b.dir, card.id, id);
  card.id = id;
  card.path = join(b.dir, `${id}.md`);
  write(b, card);
  rmSync(old);
}

// Between neighbours, so only the moved card's file changes. When doubles run out of room, everyone gets a whole number again.
export function placeAt(b: Board, cards: Stored[], at: number, card: Stored): void {
  const prev = cards[at - 1]?.rank;
  const next = cards[at]?.rank;
  if (prev === undefined) card.rank = next === undefined ? 1 : next - 1;
  else if (next === undefined) card.rank = prev + 1;
  else if (next - prev > 1e-6) card.rank = (prev + next) / 2;
  else {
    cards.splice(at, 0, card);
    cards.forEach((c, i) => {
      c.rank = i + 1;
      if (c !== card) write(b, c);
    });
    cards.splice(at, 1);
  }
}

export { readBoard, writeBoard, GENERAL_PREFIX };
