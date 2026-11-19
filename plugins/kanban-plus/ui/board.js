// The columns view: cards slide to their new place (FLIP), drag between and inside columns, Shift and the arrows move the focused one.
import { CardTile } from './card.js';
import { COLUMNS, dragging, moveCard } from './data.js';

function sideways(card, key) {
  const column = COLUMNS.indexOf(card.column) + (key === 'ArrowLeft' ? -1 : 1);
  return column >= 0 && column < COLUMNS.length ? { column: COLUMNS[column], before: null } : null;
}

/** Where a key sends a card: the next column, or one place up or down in its own. */
export function placeByKey(cards, card, key) {
  if (key === 'ArrowLeft' || key === 'ArrowRight') return sideways(card, key);
  const here = cards.filter((c) => c.column === card.column);
  const at = here.findIndex((c) => c.id === card.id);
  if (key === 'ArrowUp' && at > 0) return { column: card.column, before: here[at - 1].id };
  if (key === 'ArrowDown' && at < here.length - 1) return { column: card.column, before: here[at + 2]?.id ?? null };
  return null;
}

// The card the pointer is above, in the list under it: the dragged one does not count.
function beforeAt(e, dragged) {
  const tiles = [...e.currentTarget.querySelectorAll('[data-card]')].filter((el) => el.dataset.card !== dragged);
  return tiles.find((el) => {
    const box = el.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  })?.dataset.card ?? null;
}

function useDrag(kit, cards) {
    const { useRef, useState } = kit.React;
    const dragged = useRef(null);
    const [place, setPlace] = useState(null);
    const [draggingId, setDraggingId] = useState(null);
    const end = () => {
      dragged.current = null;
      dragging.id = null;
      setDraggingId(null);
      setPlace(null);
    };
    const over = (e, column) => {
      if (!dragged.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const before = beforeAt(e, dragged.current);
      if (place?.column !== column || place.before !== before) setPlace({ column, before });
    };
    const drop = (e, column) => {
      e.preventDefault();
      if (dragged.current && place?.column === column && cards.some((c) => c.id === dragged.current)) void moveCard(kit, dragged.current, place);
      end();
    };
    const start = (e, card) => {
      kit.mention.dragMention(e, card.path, `${card.id}: ${card.title.replace(/\s+/g, ' ')}`); // into a chat in another window
      e.dataTransfer.effectAllowed = 'copyMove';
      dragged.current = card.id;
      dragging.id = card.id;
      setDraggingId(card.id);
    };
    return { place, draggingId, over, drop, start, end };
}

function Column({ kit, id, cards, drag, tile }) {
    const h = kit.h;
    const here = drag.place?.column === id;
    const line = h('div', { 'aria-hidden': true, className: 'kp-drop-line' });
    return h('section', { 'aria-label': kit.t('column.aria', { name: kit.t(`col.${id}`) }), className: `kp-column${here ? ' kp-over' : ''}`, onDragOver: (e) => drag.over(e, id), onDrop: (e) => drag.drop(e, id) },
      h('h2', { className: 'kp-column-head' }, kit.t(`col.${id}`), h(kit.motion.Roll, { value: cards.length, className: 'kp-dim' })),
      h('ul', { className: 'kp-column-list', 'aria-label': kit.t('column.cards') },
        cards.length === 0 && !drag.place ? h('li', { className: 'kp-empty' }, kit.t('column.empty')) : null,
        cards.map((c) => h('li', { key: c.id, 'data-flip': c.id, className: 'kp-enter' }, here && drag.place.before === c.id ? line : null, tile(c))),
        here && drag.place.before === null ? line : null));
}

export function makeBoard(kit) {
  const h = kit.h;
  const { useRef, useEffect } = kit.React;
  return function Board({ cards, tabs, showProject, onOpen, onDelete, menuFor }) {
    const root = useRef(null);
    kit.motion.useFlip(root);
    const drag = useDrag(kit, cards);
    const focusAfter = useRef(null);
    // A card moved to another column is a new element: the keyboard stays on it.
    useEffect(() => {
      if (!focusAfter.current) return;
      const el = root.current?.querySelector(`[data-card="${focusAfter.current}"]`);
      if (el) {
        el.focus();
        focusAfter.current = null;
      }
    });
    const onKey = (e, card) => {
      if (e.target !== e.currentTarget) return;
      const place = e.shiftKey && e.key.startsWith('Arrow') ? placeByKey(cards, card, e.key) : null;
      // Handled here, the key does nothing else: an Enter left to the page closes the dialog it just opened.
      if (place || e.key === 'Enter' || e.key === 'Delete') e.preventDefault();
      if (place) {
        focusAfter.current = card.id;
        void moveCard(kit, card.id, place);
      } else if (e.key === 'Enter') onOpen(card);
      else if (e.key === 'Delete') onDelete(card);
    };
    const tile = (card) => h(kit.ui.ContextArea, { items: () => menuFor(card) }, h(CardTile, {
      kit, card, tabs, showProject, dragging: drag.draggingId === card.id,
      handlers: { onClick: () => onOpen(card), onKeyDown: (e) => onKey(e, card), onDragStart: (e) => drag.start(e, card), onDragEnd: drag.end },
    }));
    return h('div', { ref: root, className: 'kp-board' }, COLUMNS.map((id) => h(Column, { key: id, kit, id, cards: cards.filter((c) => c.column === id), drag, tile })));
  };
}
