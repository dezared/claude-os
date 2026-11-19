// The oldest board, data/kanban.json, one file per card in its order. A crash halfway resumes: a card already out is known by its alias.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, readBoard, writeBoard, type Stored } from './cardFile.ts';
import { httpError } from './fail.ts';
import { nextId, write, type Board } from './store.ts';
import { TASKS, type Card } from './types.ts';

function readOld(legacy: string): Partial<Card>[] {
  try {
    const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as { cards?: unknown };
    if (!Array.isArray(parsed.cards)) throw new Error('no cards');
    return parsed.cards as Partial<Card>[];
  } catch {
    throw httpError(500, `the board file is damaged: ${legacy}`);
  }
}

const fromOld = (c: Partial<Card>, id: string, dir: string, rank: number): Stored => ({
  id,
  title: c.title ?? id,
  description: c.description ?? '',
  project: c.project ?? null,
  type: 'task',
  priority: c.priority ?? 'normal',
  column: c.column ?? 'todo',
  board: TASKS,
  labels: [],
  comments: 0,
  ...(c.level ? { level: c.level } : {}),
  path: join(dir, `${id}.md`),
  created: c.created ?? Date.now(),
  updated: c.updated ?? Date.now(),
  rank,
  aliases: [String(c.id)],
  extra: '',
});

export function migrateLegacy(b: Board, legacy: string): void {
  if (!existsSync(legacy)) return;
  const old = readOld(legacy);
  const state = readBoard(b.dir);
  const cards = loadCards(b.dir, b.frontmatter);
  old.forEach((c, i) => {
    if (cards.some((x) => x.aliases.includes(String(c.id)))) return;
    const card = fromOld(c, nextId(b, state, cards, c.project ?? null), b.dir, i + 1);
    write(b, card);
    writeBoard(b.dir, state);
    cards.push(card);
  });
  writeBoard(b.dir, state);
  renameSync(legacy, `${legacy}.migrated`);
}
