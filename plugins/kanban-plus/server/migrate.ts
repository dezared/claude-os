// Boards replaced sprints. A board file from before (no `boards` key) is moved over once, at activation: the folder is
// copied to the backups first, every sprint becomes a board with its id, name, goal and project, and a card in a known
// sprint is put on that board. Nothing else in a card changes: values written by hand and unknown keys stay word for word,
// a card in no sprint is not rewritten, a sprint id no sprint had stays in its file. A crash halfway resumes: the board
// file is written last.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_FILE, cardText, loadCards, writeAtomic, writeBoard, type Frontmatter } from './cardFile.ts';
import { DEFAULT_BOARDS, GENERAL_BOARD, type KanbanBoard } from './types.ts';

interface OldSprint { id: string; name: string; board?: string; goal?: string }
interface OldState { prefixes?: Record<string, string>; counters?: Record<string, number>; sprints?: OldSprint[]; boards?: unknown }

function oldState(dir: string): OldState | null {
  const file = join(dir, BOARD_FILE);
  if (!existsSync(file)) return null;
  let state: OldState;
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as OldState;
  } catch {
    return null; // damaged: left as it is, and the board refuses it as before
  }
  return state.boards === undefined ? state : null;
}

const boardOf = (s: OldSprint): KanbanBoard => ({
  id: s.id,
  name: s.name,
  ...(s.board && s.board !== GENERAL_BOARD ? { project: s.board } : {}),
  ...(s.goal ? { goal: s.goal } : {}),
});

/** True when the folder was moved over. `backups`: where the copy of the folder goes. */
export function migrateToBoards(dir: string, frontmatter: Frontmatter, backups: string): boolean {
  const state = oldState(dir);
  if (!state) return false;
  cpSync(dir, join(backups, `kanban-before-boards-${new Date().toISOString().replace(/[:.]/g, '-')}`), { recursive: true });
  const sprints = Array.isArray(state.sprints) ? state.sprints : [];
  const ids = new Set(sprints.map((s) => s.id));
  for (const card of loadCards(dir, frontmatter)) {
    const sprint = /^sprint:\s*"?([^"\n]*)"?\s*$/m.exec(card.extra)?.[1];
    if (!sprint || !ids.has(sprint)) continue;
    card.board = sprint;
    card.extra = card.extra.split('\n').filter((l) => !l.startsWith('sprint:')).join('\n');
    writeAtomic(card.path, cardText(card));
  }
  writeBoard(dir, { prefixes: state.prefixes ?? {}, counters: state.counters ?? {}, boards: [...DEFAULT_BOARDS.map((id) => ({ id })), ...sprints.map(boardOf)] });
  return true;
}
