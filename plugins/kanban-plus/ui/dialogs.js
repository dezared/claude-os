// The small dialogs: a board's name, goal and project, a confirmation, the id prefix of a project and the keyboard help.
import { icon } from './card.js';
import { BASE, GENERAL, boardName, boardUrl, send } from './data.js';

/** A board's name, goal and project. A default board is renamed here too. */
export function BoardDialog({ kit, board, projects, onClose }) {
  const h = kit.h;
  const [form, setForm] = kit.React.useState(() => ({ name: boardName(kit, board), goal: board.goal ?? '', project: board.project ?? null }));
  const [busy, setBusy] = kit.React.useState(false);
  const set = (patch) => setForm({ ...form, ...patch });
  const save = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    const done = await send(kit, boardUrl(board.id), 'PATCH', { name: form.name.trim(), goal: form.goal, project: form.project });
    setBusy(false);
    if (done) onClose();
  };
  const { Field, Input, Textarea, ProjectSelect, Button } = kit.ui;
  return h(kit.ui.Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title: kit.t('boardMenu.editTitle') },
    h('form', { className: 'kp-form', onSubmit: (e) => { e.preventDefault(); void save(); } },
      h(Field, { label: kit.t('boardForm.name') }, h(Input, { autoFocus: true, maxLength: 80, value: form.name, onChange: (e) => set({ name: e.target.value }) })),
      h(Field, { label: kit.t('boardForm.goal') }, h(Textarea, { rows: 2, maxLength: 500, value: form.goal, onChange: (e) => set({ goal: e.target.value }) })),
      h(Field, { label: kit.t('boardForm.project'), hint: kit.t('boardForm.projectHint') }, h(ProjectSelect, { ariaLabel: kit.t('boardForm.project'), value: form.project, onChange: (project) => set({ project }), projects, extra: [{ value: null, label: kit.t('filter.noProject') }] })),
      h('div', { className: 'kp-row-end' },
        h(Button, { onClick: onClose }, kit.t('common.cancel')),
        h(Button, { type: 'submit', variant: 'primary', disabled: !form.name.trim() || busy }, kit.t('common.save')))));
}

export function ConfirmDialog({ kit, title, text, action, onConfirm, onClose }) {
  const h = kit.h;
  const [busy, setBusy] = kit.React.useState(false);
  const go = async () => {
    setBusy(true);
    await onConfirm();
    onClose();
  };
  return h(kit.ui.Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title, description: text },
    h('div', { className: 'kp-row-end' },
      h(kit.ui.Button, { onClick: onClose }, kit.t('common.cancel')),
      h(kit.ui.Button, { variant: 'danger', disabled: busy, onClick: () => void go() }, icon(kit, 'Trash2', { size: 12 }), action)));
}

/** The start of a project's ids: OS in OS-21. Every card of the project takes the new one; old ids still find them. */
export function PrefixDialog({ kit, project, name, prefixes, onClose }) {
  const h = kit.h;
  const key = project ?? GENERAL;
  const [prefix, setPrefix] = kit.React.useState(prefixes[key] ?? '');
  const save = async () => {
    const done = await send(kit, `${BASE}/prefix`, 'PUT', { project: key === GENERAL ? null : key, prefix });
    if (done) onClose();
  };
  return h(kit.ui.Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title: kit.t('settings.title', { name }) },
    h('form', { className: 'kp-form', onSubmit: (e) => { e.preventDefault(); void save(); } },
      h(kit.ui.Field, { label: kit.t('settings.prefix'), hint: kit.t('settings.prefixHint', { example: `${prefix || 'OS'}-21` }) },
        h(kit.ui.Input, { autoFocus: true, className: 'kp-mono', maxLength: 10, spellCheck: false, value: prefix, onChange: (e) => setPrefix(e.target.value.toUpperCase()) })),
      h('div', { className: 'kp-row-end' },
        h(kit.ui.Button, { onClick: onClose }, kit.t('common.cancel')),
        h(kit.ui.Button, { type: 'submit', variant: 'primary', disabled: !prefix.trim() || prefix === prefixes[key] }, kit.t('common.save')))));
}

export const SHORTCUTS = [['/', 'keys.search'], ['N', 'keys.new'], ['1', 'keys.board'], ['2', 'keys.list'], ['[ ]', 'keys.boards'], ['Enter', 'keys.open'], ['Shift + ←→↑↓', 'keys.move'], ['Delete', 'keys.delete'], ['?', 'keys.help']];

export function ShortcutsDialog({ kit, onClose }) {
  const h = kit.h;
  return h(kit.ui.Dialog, { open: true, onOpenChange: (o) => !o && onClose(), title: kit.t('keys.title') },
    h('dl', { className: 'kp-keys' }, SHORTCUTS.flatMap(([key, label]) => [h('dt', { key: `k${key}` }, h('kbd', null, key)), h('dd', { key: `d${key}` }, kit.t(label))])));
}
