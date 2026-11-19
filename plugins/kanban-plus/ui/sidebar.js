// The left side of the board app: every board with its number of cards. A card dropped on a board moves there; a new
// board is asked of Claude, which builds it and puts the cards on it with the board tools.
import { icon } from './card.js';
import { DEFAULT_BOARDS, EPICS, TASKS, boardName } from './data.js';

const BOARD_ICON = { [EPICS]: 'Zap', [TASKS]: 'SquareCheck' };

/** Claude makes a board in a chat: the user says what for, the context says how. */
export function askForBoard(kit, boards, cards) {
  const list = boards.map((b) => `- ${b.id}: ${boardName(kit, b)}${b.project ? ` (project ${b.project})` : ''}, ${cards.filter((c) => c.board === b.id).length} cards`).join('\n');
  const [change] = kit.claudeItems({
    kind: 'kanban boards',
    name: kit.t('title'),
    context: `Make or change boards with add_kanban_board and update_kanban_board; put cards on a board with update_kanban_card (its board field), find them with list_kanban_cards. A board may be for one project. Boards now:\n${list}`,
  }, { changePresets: [kit.t('ask.boardProject'), kit.t('ask.boardBugs'), kit.t('ask.boardRelease')] });
  change.onSelect();
}

export function boardMenu(kit, board, count, { rename, remove }) {
  const fixed = DEFAULT_BOARDS.includes(board.id);
  return [
    { id: 'kp.board.rename', label: kit.t('boardMenu.rename'), icon: kit.icons.Pencil, onSelect: () => rename(board) },
    {
      id: 'kp.board.delete', label: kit.t('boardMenu.delete'), icon: kit.icons.Trash2, danger: true, apart: true,
      disabled: fixed || count > 0, title: fixed ? kit.t('boardMenu.defaultStays') : count > 0 ? kit.t('boardMenu.notEmpty') : undefined,
      onSelect: () => remove(board),
    },
  ];
}

function Item({ kit, board, count, active, onPick, menu, onDropCard }) {
  const h = kit.h;
  const [over, setOver] = kit.React.useState(false);
  return h('li', { 'data-flip': `board-${board.id}`, className: 'kp-enter' }, h(kit.ui.ContextArea, { items: menu },
    h('button', {
      type: 'button', 'aria-current': active ? 'page' : undefined, 'data-board': board.id,
      className: `kp-side-item${active ? ' kp-on' : ''}${over ? ' kp-over' : ''}`,
      title: board.goal || undefined,
      onClick: onPick,
      onDragOver: (e) => { e.preventDefault(); if (!over) setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (e) => { e.preventDefault(); setOver(false); onDropCard(board.id); },
    },
    icon(kit, BOARD_ICON[board.id] ?? 'Columns3', { size: 14, className: 'kp-side-icon' }),
    h('span', { className: 'kp-truncate' }, boardName(kit, board)),
    h(kit.motion.Roll, { value: count, className: 'kp-push kp-dim kp-small' }))));
}

export function Sidebar({ kit, boards, cards, board, setBoard, onDropCard, onRename, onDelete }) {
  const h = kit.h;
  const root = kit.React.useRef(null);
  kit.motion.useFlip(root);
  const count = (id) => cards.filter((c) => c.board === id).length;
  return h('nav', { className: 'kp-side', 'aria-label': kit.t('side.aria') },
    h('h2', { className: 'kp-side-head' }, icon(kit, 'SquareKanban', { size: 14 }), kit.t('side.boards')),
    h('ul', { ref: root, className: 'kp-side-list' }, boards.map((b) => h(Item, {
      key: b.id, kit, board: b, count: count(b.id), active: b.id === board,
      onPick: () => setBoard(b.id), onDropCard,
      menu: () => boardMenu(kit, b, count(b.id), { rename: onRename, remove: onDelete }),
    }))),
    h(kit.ui.Button, { size: 'sm', className: 'kp-side-ask', onClick: () => askForBoard(kit, boards, cards) }, icon(kit, 'Sparkles', { size: 12 }), kit.t('side.ask')));
}
