// The list view: the board's cards as rows, one list per column. A card dragged onto a list moves to that column.
import { AssigneeMark, Labels, PriorityMark, TypeMark, icon, pointsOf } from './card.js';
import { COLUMNS, dragging, moveCard } from './data.js';

const points = (cards) => cards.reduce((sum, c) => sum + (c.estimate ?? 0), 0);

function Row({ kit, card, tabs, onOpen, menuFor, onDrag }) {
  const h = kit.h;
  return h('li', { 'data-flip': card.id, className: 'kp-enter' }, h(kit.ui.ContextArea, { items: () => menuFor(card) },
    h('div', {
      role: 'button', tabIndex: 0, draggable: true, 'data-card': card.id, className: 'kp-row',
      onClick: () => onOpen(card),
      onKeyDown: (e) => {
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        e.preventDefault(); // or the Enter closes the dialog it opens
        onOpen(card);
      },
      onDragStart: (e) => onDrag(e, card),
      onDragEnd: () => { dragging.id = null; },
    },
    TypeMark(kit, card.type, card.asWritten?.type),
    h('span', { className: 'kp-id' }, card.id),
    h('span', { className: 'kp-row-title' }, card.title),
    Labels(kit, card.labels, card.asWritten?.labels),
    AssigneeMark(kit, card, tabs),
    pointsOf(card) !== undefined ? h('span', { className: 'kp-points' }, pointsOf(card)) : null,
    PriorityMark(kit, card.priority))));
}

function SectionHead({ kit, column, cards, open, setOpen }) {
  const h = kit.h;
  return h('header', { className: 'kp-section-head' },
    h('button', { type: 'button', className: 'kp-section-toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
      icon(kit, 'ChevronRight', { className: `kp-chevron${open ? ' kp-open' : ''}` }),
      h('span', { className: `kp-col-tag kp-col-${column}` }, kit.t(`col.${column}`))),
    h('span', { className: 'kp-push kp-dim' }, h(kit.motion.Roll, { value: cards.length }), ' · ', kit.t('list.points', { n: points(cards) })));
}

function Section({ kit, column, cards, rowProps, onDropCard }) {
  const h = kit.h;
  const [open, setOpen] = kit.React.useState(column !== 'done');
  const [over, setOver] = kit.React.useState(false);
  return h('section', {
    'aria-label': kit.t(`col.${column}`),
    className: `kp-section${over ? ' kp-over' : ''}`,
    onDragOver: (e) => { e.preventDefault(); if (!over) setOver(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => { e.preventDefault(); setOver(false); onDropCard(column); },
  },
  h(SectionHead, { kit, column, cards, open, setOpen }),
  h(kit.motion.Fold, { show: open }, h('ul', { className: 'kp-rows' },
    cards.length === 0 ? h('li', { className: 'kp-empty' }, kit.t('list.empty')) : null,
    cards.map((c) => h(Row, { key: c.id, kit, card: c, ...rowProps })))));
}

export function makeList(kit) {
  const h = kit.h;
  return function List({ cards, tabs, onOpen, menuFor }) {
    const root = kit.React.useRef(null);
    const dragged = kit.React.useRef(null);
    kit.motion.useFlip(root);
    const onDrag = (e, card) => {
      kit.mention.dragMention(e, card.path, `${card.id}: ${card.title.replace(/\s+/g, ' ')}`);
      e.dataTransfer.effectAllowed = 'copyMove';
      dragged.current = card;
      dragging.id = card.id;
    };
    const onDropCard = (column) => {
      const card = dragged.current;
      dragged.current = null;
      if (card && card.column !== column) void moveCard(kit, card.id, { column, before: null });
    };
    const rowProps = { tabs, onOpen, menuFor, onDrag };
    return h('div', { ref: root, className: 'kp-list' },
      COLUMNS.map((column) => h(Section, { key: column, kit, column, cards: cards.filter((c) => c.column === column), rowProps, onDropCard })));
  };
}
