// The board as one object, for the routes, the tools and the tests.
import { publicCard } from './cardFile.ts';
import { addCard, cardDetail, commentCard, moveCard, recordSession, removeCard, takeCard, updateCard, type Place } from './cards.ts';
import type { CardInput } from './fields.ts';
import { addBoard, removeBoard, setPrefix, updateBoard, type BoardInput } from './boards.ts';
import { find, load, prefixes, readBoard, type BoardOptions } from './store.ts';
import type { Actor, Card, KanbanBoard } from './types.ts';

export const USER: Actor = { by: 'user' };

export function createKanban(dir: string, options: BoardOptions) {
  const b = { dir, ...options };
  return {
    dir,
    list: (filter: { board?: string } = {}): Card[] => load(b).filter((c) => filter.board === undefined || c.board === filter.board).map(publicCard),
    get: (id: unknown): Card => publicCard(find(load(b), id)),
    detail: (id: unknown) => cardDetail(b, id),
    prefixes: () => prefixes(b),
    setPrefix: (key: unknown, value: unknown) => setPrefix(b, key, value),
    add: (input: CardInput, actor = USER) => addCard(b, input, actor),
    update: (id: unknown, input: CardInput, actor = USER) => updateCard(b, id, input, actor),
    move: (id: unknown, place: Place, actor = USER) => moveCard(b, id, place, actor),
    take: (id: unknown, agent: unknown, actor: Actor) => takeCard(b, id, agent, actor),
    comment: (id: unknown, text: unknown, actor = USER) => commentCard(b, id, text, actor),
    remove: (id: unknown) => removeCard(b, id),
    recordSession: (tabId: string, sessionId: string) => recordSession(b, tabId, sessionId),
    boards: (): KanbanBoard[] => readBoard(dir).boards,
    addBoard: (input: BoardInput) => addBoard(b, input),
    updateBoard: (id: unknown, input: BoardInput) => updateBoard(b, id, input),
    removeBoard: (id: unknown) => removeBoard(b, id),
  };
}

export type Kanban = ReturnType<typeof createKanban>;
