// The Kanban+ screen: the boards on the left; the chosen one on the right with its filters, the Board and List views and the dialogs.
import { makeBoard } from './board.js';
import { BOARD_URL, DEFAULT_BOARDS, GENERAL, TASKS, TOPICS, boardName, boardUrl, cardUrl, dragging, lastBoard, patchCard, rememberBoard, send } from './data.js';
import { CardDialog, NewCardDialog } from './detail.js';
import { BoardDialog, ConfirmDialog, PrefixDialog, ShortcutsDialog } from './dialogs.js';
import { ANY_PROJECT, NO_FILTER, applyFilters } from './filters.js';
import { Header } from './header.js';
import { useShortcuts } from './keys.js';
import { makeList } from './list.js';
import { arrange, cardMenu, mention, sendToSession } from './menus.js';
import { Sidebar } from './sidebar.js';

const VIEW_STORE = 'kanban-plus.view';
const storedView = () => (localStorage.getItem(VIEW_STORE) === 'board' || !localStorage.getItem(VIEW_STORE) ? 'board' : 'list');

// `arg` from a project page or a finished service task is a project, shown as the filter; a board id opens that board.
function useBoardState(kit, arg) {
  const { useState, useEffect } = kit.React;
  const q = kit.useApi(BOARD_URL, TOPICS);
  const [chosen, setChosen] = useState(lastBoard());
  const [view, setViewRaw] = useState(storedView());
  const [filters, setFilters] = useState(NO_FILTER);
  const boards = q.data?.boards ?? [];
  const loaded = !!q.data;
  useEffect(() => {
    if (!arg || !loaded) return;
    if (boards.some((b) => b.id === arg)) setChosen(arg);
    else setFilters({ ...NO_FILTER, project: arg });
  }, [arg, loaded]);
  const setBoard = (next) => {
    rememberBoard(next);
    setChosen(next);
  };
  const setView = (next) => {
    localStorage.setItem(VIEW_STORE, next);
    setViewRaw(next);
  };
  // A board removed while chosen, or one remembered from before boards: the tasks board.
  const board = boards.find((b) => b.id === chosen) ?? boards.find((b) => b.id === TASKS) ?? null;
  return { q, boards, board, setBoard, view, setView, filters, setFilters };
}

function useDialogs(kit) {
  const [dialog, setDialog] = kit.React.useState(null);
  return { dialog, open: setDialog, close: () => setDialog(null) };
}

// The project a new card gets, and whose prefix the settings change: the one filtered by, else the board's.
const projectOf = (s) => (s.filters.project === GENERAL ? null : s.filters.project !== ANY_PROJECT ? s.filters.project : s.board?.project ?? null);

const DIALOGS = {
  card: (kit, x, c) => kit.h(CardDialog, { ...c.common, id: x.id, boards: c.s.boards, projects: c.projects, osProject: c.s.q.data?.osProject ?? null, actions: c.actions }),
  new: (kit, x, c) => kit.h(NewCardDialog, { ...c.common, board: c.s.board.id, project: projectOf(c.s), projects: c.projects, onMade: c.common.onClose }),
  delete: (kit, x, c) => kit.h(ConfirmDialog, { ...c.common, title: kit.t('card.deleteTitle', { id: x.card.id }), text: x.card.title, action: kit.t('card.delete'), onConfirm: async () => { if (await send(kit, cardUrl(x.card.id), 'DELETE')) kit.toast(kit.t('card.deleted')); } }),
  board: (kit, x, c) => kit.h(BoardDialog, { ...c.common, board: x.board, projects: c.projects }),
  boardDelete: (kit, x, c) => kit.h(ConfirmDialog, { ...c.common, title: kit.t('boardMenu.deleteTitle', { name: boardName(kit, x.board) }), text: kit.t('boardMenu.deleteHint'), action: kit.t('boardMenu.delete'), onConfirm: () => send(kit, boardUrl(x.board.id), 'DELETE') }),
  prefix: (kit, x, c) => kit.h(PrefixDialog, { ...c.common, project: projectOf(c.s), name: projectOf(c.s) ? c.colors.nameOf(projectOf(c.s)) : kit.t('filter.noProject'), prefixes: c.s.q.data?.prefixes ?? {} }),
  keys: (kit, x, c) => kit.h(ShortcutsDialog, c.common),
};

function Dialogs({ kit, s, d, projects, colors }) {
  const x = d.dialog;
  if (!x || !s.board) return null;
  const actions = { send: (c) => void sendToSession(kit, c), mention: (c) => mention(kit, c), remove: (c) => d.open({ kind: 'delete', card: c }) };
  return DIALOGS[x.kind](kit, x, { common: { kit, onClose: d.close }, s, projects, colors, actions });
}

function boardMenuItems(kit, { s, d, cards, count }) {
  const removable = !DEFAULT_BOARDS.includes(s.board.id) && count === 0;
  return [
    { id: 'kp.new', label: kit.t('card.new'), icon: kit.icons.Plus, onSelect: () => d.open({ kind: 'new' }) },
    { id: 'kp.board.rename', label: kit.t('boardMenu.rename'), icon: kit.icons.Pencil, onSelect: () => d.open({ kind: 'board', board: s.board }) },
    arrange(kit, { name: boardName(kit, s.board), board: s.board, cards }),
    { id: 'kp.prefix', label: kit.t('settings.menu'), icon: kit.icons.Settings, apart: true, onSelect: () => d.open({ kind: 'prefix' }) },
    { id: 'kp.keys', label: kit.t('keys.title'), icon: kit.icons.Keyboard, onSelect: () => d.open({ kind: 'keys' }) },
    ...(removable ? [{ id: 'kp.board.delete', label: kit.t('boardMenu.delete'), icon: kit.icons.Trash2, danger: true, apart: true, onSelect: () => d.open({ kind: 'boardDelete', board: s.board }) }] : []),
  ];
}

const Loading = (kit, q) => (q.error ? kit.h(kit.ui.ErrorState, { message: q.error, onRetry: q.refetch }) : kit.h(kit.ui.Skeleton, { lines: 8 }));

function Main({ kit, s, d, views, projects, colors, tabs, searchRef }) {
  const h = kit.h;
  const all = s.q.data.cards;
  const here = all.filter((c) => c.board === s.board.id);
  const cards = applyFilters(here, s.filters);
  const labels = [...new Set(here.flatMap((c) => c.labels))].sort();
  const menuFor = (card) => cardMenu(kit, { card, cards, boards: s.boards, tabs, open: (c) => d.open({ kind: 'card', id: c.id }), remove: (c) => d.open({ kind: 'delete', card: c }) });
  const items = () => boardMenuItems(kit, { s, d, cards, count: here.length });
  const shared = { tabs, cards, onOpen: (c) => d.open({ kind: 'card', id: c.id }), menuFor };
  return h(kit.ui.ContextArea, { items, className: 'kp-main' },
    h(Header, { kit, board: s.board, name: boardName(kit, s.board), colors, view: s.view, setView: s.setView, onNew: () => d.open({ kind: 'new' }), boardMenu: (e) => kit.openMenu(e, items()), filterProps: { filters: s.filters, setFilters: s.setFilters, labels, projects, searchRef } }),
    h('div', { key: `${s.board.id}-${s.view}`, className: 'kp-view kp-fade' },
      s.view === 'board'
        ? h(views.Board, { ...shared, showProject: colors, onDelete: (c) => d.open({ kind: 'delete', card: c }) })
        : h(views.List, shared)));
}

export function makeApp(kit) {
  const h = kit.h;
  const views = { Board: makeBoard(kit), List: makeList(kit) };
  return function KanbanApp({ arg }) {
    const s = useBoardState(kit, arg);
    const d = useDialogs(kit);
    const searchRef = kit.React.useRef(null);
    const projects = (kit.useApi('/api/projects', ['projects']).data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const tabs = kit.useApi('/api/tabs', ['tabs']).data ?? [];
    const colors = kit.useProjectColors();
    useShortcuts(kit, { s, d, searchRef });
    const onDropCard = (board) => {
      const id = dragging.id;
      dragging.id = null;
      const card = s.q.data?.cards.find((c) => c.id === id);
      if (card && card.board !== board) void patchCard(kit, card.id, { board });
    };
    if (!s.q.data || !s.board) return h('div', { className: 'kp-app' }, h('div', { className: 'kp-main kp-pad' }, Loading(kit, s.q)));
    return h('div', { className: 'kp-app' },
      h(Sidebar, { kit, boards: s.boards, cards: s.q.data.cards, board: s.board.id, setBoard: s.setBoard, onDropCard, onRename: (b) => d.open({ kind: 'board', board: b }), onDelete: (b) => d.open({ kind: 'boardDelete', board: b }) }),
      h(Main, { kit, s, d, views, projects, colors, tabs, searchRef }),
      h(Dialogs, { kit, s, d, projects, colors }));
  };
}
