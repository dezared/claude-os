// The top of a board: its name and goal, the view, the new card and the board's menu; the filters under them.
import { icon } from './card.js';
import { FilterBar } from './filters.js';

function Title({ kit, name, board, colors }) {
  const h = kit.h;
  const project = board?.project;
  return h('div', { className: 'kp-title-box' },
    h('h1', { key: name, className: 'kp-title kp-fade' }, h('span', { className: 'kp-truncate' }, name)),
    project ? h('span', { className: 'kp-meta kp-dim' }, h(kit.ui.ProjectIcon, { project, name: colors.nameOf(project), color: colors.color(project), size: 12 }), colors.nameOf(project)) : null,
    board?.goal ? h('span', { className: 'kp-dim kp-truncate kp-goal', title: board.goal }, board.goal) : null);
}

export function Header({ kit, board, name, colors, view, setView, onNew, boardMenu, filterProps }) {
  const h = kit.h;
  const { Segmented, Button, IconButton } = kit.ui;
  return h('header', { className: 'kp-header' },
    h('div', { className: 'kp-header-top' },
      h(Title, { kit, name, board, colors }),
      h('span', { className: 'kp-push' }),
      h(Segmented, { ariaLabel: kit.t('view.aria'), value: view, onChange: setView, options: [{ value: 'board', label: kit.t('view.board'), icon: kit.icons.Columns3 }, { value: 'list', label: kit.t('view.list'), icon: kit.icons.ListTodo }] }),
      h(Button, { variant: 'primary', onClick: onNew, title: 'N' }, icon(kit, 'Plus'), kit.t('card.new')),
      h(IconButton, { label: kit.t('board.menu'), onClick: boardMenu }, icon(kit, 'MoreHorizontal'))),
    h(FilterBar, { kit, ...filterProps }));
}
