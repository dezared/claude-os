// The fields beside a card: each change goes to the server at once, as in a tracker; text fields when they lose focus.
import { icon } from './card.js';
import { COLUMNS, PRIORITIES, PRIORITY_ICON, TYPES, TYPE_ICON, boardName, moveCard, patchCard } from './data.js';

function Line({ kit, label, children }) {
  return kit.h('div', { className: 'kp-field' }, kit.h('span', { className: 'kp-field-label' }, label), children);
}

const options = (kit, values, names, icons) => values.map((v) => ({ value: v, label: kit.t(`${names}.${v}`), ...(icons ? { icon: kit.icons[icons[v]] } : {}) }));

/** Text saved when it loses focus or on Enter; Escape puts back what is saved. */
function TextField({ kit, label, value, onSave, ...rest }) {
  const [draft, setDraft] = kit.React.useState(null);
  const save = () => {
    if (draft !== null && draft !== value) onSave(draft);
    setDraft(null);
  };
  return kit.h(kit.ui.Input, {
    'aria-label': label, value: draft ?? value, ...rest,
    onChange: (e) => setDraft(e.target.value),
    onBlur: save,
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') setDraft(null);
    },
  });
}

function assigneeOptions(kit, card) {
  return [
    { value: 'none', label: kit.t('who.nobody') },
    { value: 'user', label: kit.t('who.me'), icon: kit.icons.User },
    ...(card.agent ? [{ value: 'agent', label: card.agent, icon: kit.icons.Bot }] : []),
    ...(card.asWritten?.assignee ? [{ value: 'written', label: card.asWritten.assignee, icon: kit.icons.User }] : []),
  ];
}

const whoOf = (card) => (card.agent ? 'agent' : card.asWritten?.assignee ? 'written' : card.assignee === 'user' ? 'user' : 'none');

// A type written by hand that the board has no name for stays selected, as written, until another is chosen.
const typeOptions = (kit, card) => [...options(kit, TYPES, 'type', TYPE_ICON), ...(card.asWritten?.type ? [{ value: card.asWritten.type, label: card.asWritten.type }] : [])];

// What the fields show: a value written by hand that the board does not read stays as written (card.asWritten).
const shownOf = (card) => ({
  type: card.asWritten?.type ?? card.type,
  labels: card.asWritten?.labels ?? card.labels.join(', '),
  estimate: card.asWritten?.estimate ?? (card.estimate === undefined ? '' : String(card.estimate)),
});


export function CardFields({ kit, card, boards, projects, osProject }) {
  const h = kit.h;
  const { Select, ProjectSelect, Segmented } = kit.ui;
  const patch = (body) => void patchCard(kit, card.id, body);
  const estimate = (v) => patch({ estimate: v.trim() === '' ? null : Number(v.replace(',', '.')) });
  const shown = shownOf(card);
  return h('div', { className: 'kp-fields' },
    h(Line, { kit, label: kit.t('field.column') }, h(Select, { ariaLabel: kit.t('field.column'), value: card.column, onChange: (column) => void moveCard(kit, card.id, { column, before: null }), options: options(kit, COLUMNS, 'col') })),
    h(Line, { kit, label: kit.t('field.type') }, h(Select, { ariaLabel: kit.t('field.type'), value: shown.type, onChange: (type) => TYPES.includes(type) && patch({ type }), options: typeOptions(kit, card) })),
    h(Line, { kit, label: kit.t('field.priority') }, h(Select, { ariaLabel: kit.t('field.priority'), value: card.priority, onChange: (priority) => patch({ priority }), options: options(kit, PRIORITIES, 'prio', PRIORITY_ICON) })),
    h(Line, { kit, label: kit.t('field.assignee') }, h(Select, { ariaLabel: kit.t('field.assignee'), value: whoOf(card), onChange: (v) => (v === 'user' || v === 'none') && patch({ assignee: v === 'user' ? 'user' : null }), options: assigneeOptions(kit, card) })),
    h(Line, { kit, label: kit.t('field.board') }, h(Select, { ariaLabel: kit.t('field.board'), value: card.board, onChange: (board) => patch({ board }), options: boards.map((b) => ({ value: b.id, label: boardName(kit, b) })) })),
    h(Line, { kit, label: kit.t('field.labels') }, h(TextField, { kit, label: kit.t('field.labels'), value: shown.labels, placeholder: kit.t('field.labelsHint'), onSave: (v) => patch({ labels: v.split(',').map((l) => l.trim()).filter(Boolean) }) })),
    h(Line, { kit, label: kit.t('field.estimate') }, h(TextField, { kit, label: kit.t('field.estimate'), value: shown.estimate, inputMode: 'decimal', placeholder: kit.t('field.estimateHint'), onSave: estimate })),
    h(Line, { kit, label: kit.t('field.project') }, h(ProjectSelect, { ariaLabel: kit.t('field.project'), value: card.project, onChange: (project) => patch({ project }), projects, extra: [{ value: null, label: kit.t('filter.noProject') }] })),
    card.project !== null && card.project === osProject ? h(Line, { kit, label: kit.t('field.level') }, h(Segmented, { ariaLabel: kit.t('field.level'), value: card.level ?? 'none', onChange: (v) => patch({ level: v === 'none' ? null : v }), options: ['none', 'user', 'root'].map((v) => ({ value: v, label: kit.t(`level.${v}`) })) })) : null,
    h('p', { className: 'kp-dim kp-small' }, kit.t('card.created', { at: kit.format.fmtDateTime(card.created) }), h('br'), kit.t('card.updated', { at: kit.format.fmtAgo(card.updated) })),
    h('p', { className: 'kp-dim kp-small kp-path', title: card.path }, icon(kit, 'BookOpen', { size: 11 }), card.path));
}
