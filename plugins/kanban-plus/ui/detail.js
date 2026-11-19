// A card opened: the title and the description in Markdown on the left with the comments, log and sessions under them;
// the fields on the right. And the dialog for a new card.
import { icon } from './card.js';
import { BASE, EPICS, PRIORITIES, TOPICS, TYPES, cardUrl, patchCard, send } from './data.js';
import { CardFields } from './fields.js';
import { CardLog } from './log.js';

function Description({ kit, card }) {
  const h = kit.h;
  const [draft, setDraft] = kit.React.useState(null);
  const save = async () => {
    if (draft !== card.description) await patchCard(kit, card.id, { description: draft });
    setDraft(null);
  };
  if (draft === null) {
    return h('div', { className: 'kp-desc', role: 'button', tabIndex: 0, title: kit.t('desc.edit'), onClick: () => setDraft(card.description), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); setDraft(card.description); } } },
      card.description.trim() ? h(kit.ui.Markdown, { text: card.description }) : h('span', { className: 'kp-dim' }, kit.t('desc.empty')));
  }
  return h('div', { className: 'kp-desc-edit kp-fade' },
    h(kit.ui.Textarea, { autoFocus: true, 'aria-label': kit.t('field.description'), rows: 9, value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? void save() : e.key === 'Escape' && (e.stopPropagation(), setDraft(null))) }),
    h('div', { className: 'kp-row-end' },
      h('span', { className: 'kp-dim kp-small' }, kit.t('desc.hint')),
      h(kit.ui.Button, { size: 'sm', onClick: () => setDraft(null) }, kit.t('common.cancel')),
      h(kit.ui.Button, { size: 'sm', variant: 'primary', onClick: () => void save() }, kit.t('common.save'))));
}

function Title({ kit, card }) {
  const [draft, setDraft] = kit.React.useState(null);
  const save = () => {
    if (draft !== null && draft.trim() && draft !== card.title) void patchCard(kit, card.id, { title: draft });
    setDraft(null);
  };
  return kit.h('textarea', {
    'aria-label': kit.t('field.title'), className: 'kp-title-edit', rows: 1, maxLength: 200, value: draft ?? card.title,
    onChange: (e) => setDraft(e.target.value.replace(/\n/g, ' ')), onBlur: save,
    onKeyDown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === 'Escape' && draft !== null) { e.stopPropagation(); setDraft(null); }
    },
  });
}

function Actions({ kit, card, actions }) {
  const h = kit.h;
  const { Button } = kit.ui;
  return h('div', { className: 'kp-actions' },
    h(Button, { size: 'sm', disabled: !card.project, title: card.project ? undefined : kit.t('card.sendNeedsProject'), onClick: () => actions.send(card) }, icon(kit, 'MessageSquarePlus', { size: 12 }), kit.t('card.send')),
    h(Button, { size: 'sm', onClick: () => actions.mention(card) }, icon(kit, 'AtSign', { size: 12 }), kit.t('card.mention')),
    h(Button, { size: 'sm', variant: 'danger', onClick: () => actions.remove(card) }, icon(kit, 'Trash2', { size: 12 }), kit.t('card.delete')));
}

export function CardDialog({ kit, id, boards, projects, osProject, actions, onClose }) {
  const h = kit.h;
  const q = kit.useApi(cardUrl(id), [...TOPICS, 'tabs', 'sessions']);
  const data = q.data;
  const title = data ? `${data.card.id} · ${data.card.asWritten?.type ?? kit.t(`type.${data.card.type}`)}` : id;
  return h(kit.ui.Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title, width: 980 },
    !data ? (q.error ? h(kit.ui.ErrorState, { message: q.error, onRetry: q.refetch }) : h(kit.ui.Skeleton, { lines: 8 })) : h('div', { className: 'kp-detail' },
      h('div', { className: 'kp-detail-main' },
        h(Title, { key: data.card.id, kit, card: data.card }),
        h(Description, { key: `d${data.card.id}`, kit, card: data.card }),
        h(CardLog, { kit, card: data.card, log: data.log, sessions: data.sessions, boards })),
      h('aside', { className: 'kp-detail-side' },
        h(CardFields, { kit, card: data.card, boards, projects, osProject }),
        h(Actions, { kit, card: data.card, actions }))));
}

/** A new card goes onto the board on screen, in its project or the one filtered by, so it does not vanish from view the moment
 *  it is made. On the epics board it is an epic. */
export function NewCardDialog({ kit, board, project, projects, onClose, onMade }) {
  const h = kit.h;
  const { useState } = kit.React;
  const [form, setForm] = useState({ title: '', description: '', type: board === EPICS ? 'epic' : 'task', priority: 'normal', project });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm({ ...form, ...patch });
  const { Field, Input, Textarea, Select, ProjectSelect, Button, Dialog } = kit.ui;
  const save = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    const card = await send(kit, `${BASE}/cards`, 'POST', { ...form, board });
    setBusy(false);
    if (card) onMade(card);
  };
  return h(Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title: kit.t('card.newTitle'), width: 560 },
    h('form', { className: 'kp-form', onSubmit: (e) => { e.preventDefault(); void save(); } },
      h(Field, { label: kit.t('field.title') }, h(Input, { autoFocus: true, maxLength: 200, value: form.title, onChange: (e) => set({ title: e.target.value }) })),
      h(Field, { label: kit.t('field.description'), hint: kit.t('desc.markdown') }, h(Textarea, { rows: 6, value: form.description, onChange: (e) => set({ description: e.target.value }) })),
      h('div', { className: 'kp-row-wrap' },
        h(Select, { ariaLabel: kit.t('field.type'), className: 'kp-select', value: form.type, onChange: (type) => set({ type }), options: TYPES.map((v) => ({ value: v, label: kit.t(`type.${v}`) })) }),
        h(Select, { ariaLabel: kit.t('field.priority'), className: 'kp-select', value: form.priority, onChange: (priority) => set({ priority }), options: PRIORITIES.map((v) => ({ value: v, label: kit.t(`prio.${v}`) })) }),
        h(ProjectSelect, { ariaLabel: kit.t('field.project'), className: 'kp-select-wide', value: form.project, onChange: (p) => set({ project: p }), projects, extra: [{ value: null, label: kit.t('filter.noProject') }] })),
      h('div', { className: 'kp-row-end' },
        h(Button, { onClick: onClose }, kit.t('common.cancel')),
        h(Button, { type: 'submit', variant: 'primary', disabled: !form.title.trim() || busy }, kit.t('card.create')))));
}
