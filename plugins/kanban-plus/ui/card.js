// A card on the board and in the backlog lists, and the small marks both use: type, priority, assignee.
import { PRIORITY_ICON, TYPE_ICON } from './data.js';

export function icon(kit, name, props = {}) {
  const Icon = kit.icons[name];
  return kit.h(Icon, { size: 13, 'aria-hidden': true, ...props });
}

// `written`: a value from the file the board has no name for (card.asWritten), shown as it is.
export const TypeMark = (kit, type, written) => (written
  ? kit.h('span', { className: 'kp-type kp-type-raw kp-truncate', title: written }, written)
  : kit.h('span', { className: `kp-type kp-type-${type}`, title: kit.t(`type.${type}`) }, icon(kit, TYPE_ICON[type], { size: 12 })));
export const PriorityMark = (kit, priority) => kit.h('span', { className: `kp-prio kp-prio-${priority}`, title: kit.t(`prio.${priority}`), 'aria-label': kit.t(`prio.${priority}`) }, icon(kit, PRIORITY_ICON[priority], { size: 13 }));

/** The user, an agent with its tab's state, or nobody. */
export function AssigneeMark(kit, card, tabs) {
  if (card.agent) {
    const working = tabs.some((t) => t.id === card.agentTab && t.status === 'working');
    return kit.h('span', { className: 'kp-who kp-who-agent', 'data-card-agent': '', title: kit.t('who.agent', { name: card.agent }) },
      icon(kit, 'Bot', { size: 11, className: working ? 'kp-working' : '' }), kit.h('span', { className: 'kp-truncate' }, card.agent));
  }
  const written = card.asWritten?.assignee;
  if (written) return kit.h('span', { className: 'kp-who', title: written }, icon(kit, 'User', { size: 11 }), kit.h('span', { className: 'kp-truncate' }, written));
  if (card.assignee === 'user') return kit.h('span', { className: 'kp-who', title: kit.t('who.user') }, icon(kit, 'User', { size: 11 }), kit.t('who.me'));
  return null;
}

export const Labels = (kit, labels, written) => (written
  ? kit.h('span', { className: 'kp-labels' }, kit.h('span', { className: 'kp-label' }, written))
  : labels.length ? kit.h('span', { className: 'kp-labels' }, labels.map((l) => kit.h('span', { key: l, className: 'kp-label' }, l))) : null);

/** Story points, or the estimate as written when it is not a number ("2h"). */
export const pointsOf = (card) => card.asWritten?.estimate ?? card.estimate;

function footer(kit, card, tabs, showProject) {
  const { ProjectIcon } = kit.ui;
  const who = AssigneeMark(kit, card, tabs);
  const parts = [
    showProject && card.project ? kit.h('span', { key: 'p', className: 'kp-meta' }, kit.h(ProjectIcon, { project: card.project, name: showProject.nameOf(card.project), color: showProject.color(card.project), size: 12 }), kit.h('span', { className: 'kp-truncate' }, showProject.nameOf(card.project))) : null,
    card.level ? kit.h('span', { key: 'l', className: `kp-level kp-level-${card.level}`, title: kit.t(`level.${card.level}Title`) }, card.level) : null,
    pointsOf(card) !== undefined ? kit.h('span', { key: 'e', className: 'kp-points', title: kit.t('field.estimate') }, pointsOf(card)) : null,
    card.comments ? kit.h('span', { key: 'c', className: 'kp-meta', title: kit.t('tab.comments') }, icon(kit, 'MessageSquare', { size: 11 }), card.comments) : null,
    who ? kit.h('span', { key: 'w', className: 'kp-push' }, who) : null,
  ].filter(Boolean);
  return parts.length ? kit.h('div', { className: 'kp-tile-foot' }, parts) : null;
}

/** The tile itself; the board and the backlog give it the handlers of where it stands. */
export function CardTile({ kit, card, tabs, showProject, dragging, handlers }) {
  return kit.h('div', {
    role: 'button',
    tabIndex: 0,
    'data-card': card.id,
    draggable: true,
    title: kit.t('card.hint'),
    className: `kp-tile${dragging ? ' kp-dragging' : ''}`,
    ...handlers,
  },
  kit.h('div', { className: 'kp-tile-head' }, TypeMark(kit, card.type, card.asWritten?.type), kit.h('span', { className: 'kp-id', 'data-card-id': '' }, card.id), kit.h('span', { className: 'kp-push' }, PriorityMark(kit, card.priority))),
  kit.h('div', { className: 'kp-tile-title' }, card.title),
  Labels(kit, card.labels, card.asWritten?.labels),
  footer(kit, card, tabs, showProject));
}
