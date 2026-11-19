// What happens to a card: added, edited, moved, taken, commented on, deleted. Each change goes into the card's log.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readLog } from './activity.ts';
import { publicCard, readBoard, writeBoard, type Stored } from './cardFile.ts';
import { addSession, applyFields, setAgent, setBoard, type CardInput } from './fields.ts';
import { httpError } from './fail.ts';
import { find, load, log, nextId, placeAt, project, rekey, write, type Board } from './store.ts';
import { defaultBoard, type Activity, type Actor, type Card, type Column } from './types.ts';
import * as check from './validate.ts';

export interface Place { column: unknown; before?: unknown; board?: unknown; agent?: unknown }

const WAITING: Column[] = ['backlog', 'todo'];

export function addCard(b: Board, input: CardInput, actor: Actor): Card {
  const now = Date.now();
  const cards = load(b);
  const state = readBoard(b.dir);
  const owner = project(b, input.project);
  const card: Stored = { id: '', title: check.title(input.title), description: '', project: owner, type: 'task', priority: 'normal', column: input.column === undefined ? 'backlog' : check.column(input.column), board: '', labels: [], comments: 0, path: '', created: now, updated: now, rank: (cards.at(-1)?.rank ?? 0) + 1, aliases: [], extra: '' };
  applyFields(b, card, { ...input, project: undefined, agentTab: input.agentTab ?? actor.tab });
  if (input.board === undefined) card.board = defaultBoard(card.type);
  card.id = nextId(b, state, cards, owner);
  card.path = join(b.dir, `${card.id}.md`);
  write(b, card);
  writeBoard(b.dir, state);
  log(b, card.id, actor, { kind: 'created', to: card.column });
  return publicCard(card);
}

export function updateCard(b: Board, id: unknown, input: CardInput, actor: Actor): Card {
  const cards = load(b);
  const before = find(cards, id);
  const card = { ...before, updated: Date.now() };
  const fields = applyFields(b, card, input);
  if (card.project !== before.project) {
    const state = readBoard(b.dir);
    rekey(b, card, nextId(b, state, cards, card.project));
    writeBoard(b.dir, state);
  } else write(b, card);
  const plain = fields.filter((f) => f !== 'board');
  if (plain.length) log(b, card.id, actor, { kind: 'edited', fields: plain });
  if (before.board !== card.board) log(b, card.id, actor, { kind: 'board', from: before.board, to: card.board });
  return publicCard(card);
}

function placeIn(cards: Stored[], target: Column, before: unknown): number {
  if (before === null || before === undefined) return cards.findLastIndex((c) => c.column === target) + 1 || cards.length;
  const other = find(cards, before);
  if (other.column !== target) throw httpError(400, 'the card to stand before is in another column');
  return cards.indexOf(other);
}

// Before another card of the column, or at its end: a position that means the same on a filtered board.
// Back in the queue nobody is working on it, so the agent's mark goes unless a new one is given.
export function moveCard(b: Board, id: unknown, place: Place, actor: Actor): Card {
  const target = check.column(place.column);
  const cards = load(b);
  const found = find(cards, id);
  cards.splice(cards.indexOf(found), 1);
  const moved = { ...found, column: target, updated: Date.now() };
  if (place.board !== undefined) setBoard(b, moved, place.board);
  if (place.agent !== undefined) {
    setAgent(moved, place.agent, actor.tab);
    if (moved.agentTab) addSession(moved, b.sessionOf?.(moved.agentTab));
  } else if (WAITING.includes(target)) setAgent(moved, null, null);
  placeAt(b, cards, placeIn(cards, target, place.before), moved);
  write(b, moved);
  if (found.column !== target) log(b, moved.id, actor, { kind: 'moved', from: found.column, to: target });
  if (found.board !== moved.board) log(b, moved.id, actor, { kind: 'board', from: found.board, to: moved.board });
  return publicCard(moved);
}

/** An agent takes the task: its name goes on the card, and a task still waiting goes to "doing". */
export function takeCard(b: Board, id: unknown, agent: unknown, actor: Actor): Card {
  const name = check.agentName(agent);
  const card = find(load(b), id);
  let taken: Card;
  if (WAITING.includes(card.column)) taken = moveCard(b, card.id, { column: 'doing', agent: name }, { ...actor, by: name });
  else {
    setAgent(card, name, actor.tab);
    if (card.agentTab) addSession(card, b.sessionOf?.(card.agentTab));
    card.updated = Date.now();
    write(b, card);
    taken = publicCard(card);
  }
  log(b, card.id, { ...actor, by: name }, { kind: 'taken', text: name });
  return taken;
}

export function commentCard(b: Board, id: unknown, text: unknown, actor: Actor): Activity {
  const card = find(load(b), id);
  const clean = check.comment(text);
  log(b, card.id, actor, { kind: 'comment', text: clean });
  return readLog(b.dir, card.id).at(-1)!;
}

/** The card with its log, oldest first. */
export function cardDetail(b: Board, id: unknown): { card: Card; log: Activity[] } {
  const card = find(load(b), id);
  return { card: publicCard(card), log: readLog(b.dir, card.id) };
}

/** A tab got a session: every card it works on remembers it. False: nothing changed. */
export function recordSession(b: Board, tabId: string, sessionId: string): boolean {
  let changed = false;
  // A finished card is history: a tab that goes on to other work does not add to it.
  for (const card of load(b).filter((c) => c.agentTab === tabId && (c.column === 'doing' || c.column === 'polish'))) {
    if (!addSession(card, sessionId)) continue;
    write(b, card);
    changed = true;
  }
  return changed;
}

// Deleting moves the file aside, as the planner does: a card's text may exist nowhere else. Its log stays where it is.
export function removeCard(b: Board, id: unknown): void {
  const card = find(load(b), id);
  const trash = join(b.dir, '.trash');
  mkdirSync(trash, { recursive: true });
  renameSync(card.path, join(trash, existsSync(join(trash, `${card.id}.md`)) ? `${card.id}.${Date.now()}.md` : `${card.id}.md`));
}
