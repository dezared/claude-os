// What the board app reads and writes, through the plugin's routes under /api/plugins/kanban-plus.
export const BASE = '/api/plugins/kanban-plus';
export const TOPICS = ['osPluginData'];
export const BOARD_URL = `${BASE}/board`;
export const GENERAL = '@general';
export const EPICS = 'epics';
export const TASKS = 'tasks';
export const DEFAULT_BOARDS = [EPICS, TASKS];
export const COLUMNS = ['backlog', 'todo', 'doing', 'polish', 'done'];
export const TYPES = ['task', 'bug', 'story', 'epic', 'chore'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export const TYPE_ICON = { task: 'SquareCheck', bug: 'Bug', story: 'Bookmark', epic: 'Zap', chore: 'Wrench' };
export const PRIORITY_ICON = { low: 'ChevronsDown', normal: 'Equal', high: 'ChevronsUp', urgent: 'Flag' };

const enc = encodeURIComponent;
export const cardUrl = (id) => `${BASE}/cards/${enc(id)}`;
export const boardUrl = (id) => `${BASE}/boards/${enc(id)}`;

/** A request whose refusal is shown and answers null; every screen that reads the board refetches after it. */
export async function send(kit, path, method, body) {
  try {
    const out = await kit.api(path, { method, body });
    kit.refresh(TOPICS);
    return out;
  } catch (e) {
    kit.toastError(e);
    kit.refresh(TOPICS);
    return null;
  }
}

/** On the screen at once, on the server a moment later; a refusal brings the server's order back. */
export function moveCard(kit, id, place) {
  kit.setCached(BOARD_URL, (old) => {
    if (!old) return old;
    const card = old.cards.find((c) => c.id === id);
    if (!card) return old;
    const rest = old.cards.filter((c) => c.id !== id);
    const last = rest.findLastIndex((c) => c.column === place.column);
    const at = place.before ? rest.findIndex((c) => c.id === place.before) : last >= 0 ? last + 1 : rest.length;
    rest.splice(at, 0, { ...card, column: place.column, ...(place.board ? { board: place.board } : {}) });
    return { ...old, cards: rest };
  });
  return send(kit, `${cardUrl(id)}/move`, 'POST', place);
}

/** A field changed on the screen first, as in moveCard. */
export function patchCard(kit, id, body) {
  kit.setCached(BOARD_URL, (old) => (old ? { ...old, cards: old.cards.map((c) => (c.id === id ? { ...c, ...body } : c)) } : old));
  return send(kit, cardUrl(id), 'PATCH', body);
}

/** The card being dragged, from the board or the list, for a drop on a board in the sidebar. */
export const dragging = { id: null };

/** A default board never renamed has the interface's name. */
export const boardName = (kit, board) => board?.name ?? (board ? kit.t(`board.${board.id}`) : '');

export const defaultBoard = (type) => (type === 'epic' ? EPICS : TASKS);

const STORE = 'kanban-plus.board';
export const lastBoard = () => localStorage.getItem(STORE) ?? TASKS;
export const rememberBoard = (board) => localStorage.setItem(STORE, board);
