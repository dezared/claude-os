// Boards and id prefixes: what lives in _board.json rather than in one card.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBoard, writeBoard } from './cardFile.ts';
import { httpError } from './fail.ts';
import { load, nextId, prefixOf, project, rekey, type Board } from './store.ts';
import { DEFAULT_BOARDS, GENERAL_BOARD, type KanbanBoard } from './types.ts';
import * as check from './validate.ts';

const BOARD_COUNTER = '@board'; // not a prefix: those start with a capital
const PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;

export interface BoardInput { name?: unknown; project?: unknown; goal?: unknown }

// null or "" takes the project or the goal away.
function applyBoard(b: Board, board: KanbanBoard, input: BoardInput): void {
  if (input.name !== undefined) board.name = check.boardName(input.name);
  if (input.project !== undefined) {
    const owner = project(b, input.project);
    if (owner) board.project = owner;
    else delete board.project;
  }
  if (input.goal !== undefined) {
    const goal = check.goal(input.goal);
    if (goal) board.goal = goal;
    else delete board.goal;
  }
}

export function addBoard(b: Board, input: BoardInput): KanbanBoard {
  const state = readBoard(b.dir);
  const number = Math.max(state.counters[BOARD_COUNTER] ?? 0, ...state.boards.map((x) => Number(/^B(\d+)$/.exec(x.id)?.[1] ?? 0))) + 1;
  const board: KanbanBoard = { id: `B${number}`, name: check.boardName(input.name) };
  applyBoard(b, board, { ...input, name: undefined });
  state.counters[BOARD_COUNTER] = number;
  state.boards.push(board);
  writeBoard(b.dir, state);
  return board;
}

export function updateBoard(b: Board, id: unknown, input: BoardInput): KanbanBoard {
  const state = readBoard(b.dir);
  const board = state.boards.find((x) => x.id === id);
  if (!board) throw httpError(404, `no board ${String(id)}`);
  applyBoard(b, board, input);
  writeBoard(b.dir, state);
  return board;
}

/** Only an empty board goes, and never a default one: a card with no board needs somewhere to stand. */
export function removeBoard(b: Board, id: unknown): void {
  const state = readBoard(b.dir);
  if (!state.boards.some((x) => x.id === id)) throw httpError(404, `no board ${String(id)}`);
  if ((DEFAULT_BOARDS as readonly unknown[]).includes(id)) throw httpError(400, 'a default board stays');
  if (load(b).some((c) => c.board === id)) throw httpError(409, 'the board has cards: move them to another board first');
  state.boards = state.boards.filter((x) => x.id !== id);
  writeBoard(b.dir, state);
}

type Owned = { project: string | null; id: string };

const takenElsewhere = (prefixes: Record<string, string>, cards: Owned[], owner: string | null, clean: string) =>
  Object.entries(prefixes).some(([k, p]) => k !== (owner ?? GENERAL_BOARD) && p === clean) || cards.some((c) => c.project !== owner && c.id.startsWith(`${clean}-`));

function renumber(b: Board, cards: ReturnType<typeof load>, state: ReturnType<typeof readBoard>, owner: string | null) {
  const clean = state.prefixes[owner ?? GENERAL_BOARD];
  for (const card of cards.filter((c) => c.project === owner)) {
    const number = Number(card.id.slice(card.id.lastIndexOf('-') + 1));
    const free = !existsSync(join(b.dir, `${clean}-${number}.md`));
    rekey(b, card, free ? `${clean}-${number}` : nextId(b, state, cards, owner));
  }
}

/** Every card of the project takes the new prefix and keeps its number; its old id stays as an alias. */
export function setPrefix(b: Board, key: unknown, value: unknown): string {
  const clean = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!PREFIX.test(clean)) throw httpError(400, 'a prefix is a Latin capital, then capitals or digits, up to 10');
  const owner = project(b, key);
  const cards = load(b);
  const state = readBoard(b.dir);
  const current = prefixOf(b, state, owner);
  if (current !== clean) {
    if (takenElsewhere(state.prefixes, cards, owner, clean)) throw httpError(409, `the prefix ${clean} is already taken`);
    state.prefixes[owner ?? GENERAL_BOARD] = clean;
    state.counters[clean] = Math.max(state.counters[clean] ?? 0, state.counters[current] ?? 0);
    renumber(b, cards, state, owner);
  }
  writeBoard(b.dir, state);
  return clean;
}
