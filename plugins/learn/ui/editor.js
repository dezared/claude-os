// A track's settings and roadmap as a form: the user makes and configures a course here without Claude.
import { uniqueId } from './data.js';

const LANGUAGES = ['ru', 'en'];
const STATUSES = ['todo', 'done', 'skipped'];
const STATUS_LABEL = { todo: 'statusTodo', done: 'statusDone', skipped: 'statusSkipped' };

let c;
const h = (...args) => c.React.createElement(...args);
let draftKey = 0;

export function makeEditor(ctx) {
  c = ctx;
  return TrackForm;
}

const TEXT_FIELDS = ['title', 'goal', 'level', 'style'];
function draftOf(track) {
  const draft = Object.fromEntries(TEXT_FIELDS.map((k) => [k, track[k] ?? '']));
  return { ...draft, language: track.language ?? c.host.lang(), nodes: (track.nodes ?? []).map((n) => ({ ...n, key: n.id, summary: n.summary ?? '' })) };
}

/** Draft rows back to roadmap nodes: a kept node keeps its id, a new one gets one like the MCP server would give it. */
function nodesOf(rows) {
  const taken = new Set(rows.filter((r) => r.id).map((r) => r.id));
  return rows.filter((r) => r.title.trim()).map((r) => ({
    id: r.id ?? uniqueId(r.title, taken, 'step'), title: r.title.trim(), summary: r.summary.trim() || null, status: r.status ?? 'todo',
  }));
}

export const fieldsOf = (draft) => ({
  title: draft.title.trim(), goal: draft.goal.trim() || null, level: draft.level.trim() || null, language: draft.language,
  style: draft.style.trim() || null, nodes: nodesOf(draft.nodes),
});

function Field({ id, label, children }) {
  return h('div', { className: 'lrn-field' }, h('label', { className: 'lrn-label', htmlFor: id }, label), children);
}

function NodeEditor({ row, index, count, set, move, remove }) {
  const { text, icons } = c;
  const change = (key) => (e) => set({ ...row, [key]: e.target.value });
  const tool = (label, icon, onClick, disabled) => h('button', { type: 'button', className: 'lrn-icon-btn press', 'aria-label': label, title: label, disabled, onClick }, h(icon, { size: 13 }));
  return h('li', { className: 'lrn-edit-node', 'data-flip': row.key, 'data-testid': 'learn-edit-node' },
    h('span', { className: 'lrn-edit-num' }, index + 1),
    h('div', { className: 'lrn-edit-texts' },
      h('input', { className: 'lrn-input', value: row.title, placeholder: text.stepTitle, 'aria-label': text.stepTitle, onChange: change('title') }),
      h('input', { className: 'lrn-input lrn-input-soft', value: row.summary, placeholder: text.stepSummary, 'aria-label': text.stepSummary, onChange: change('summary') })),
    h('select', { className: 'lrn-input lrn-select', value: row.status ?? 'todo', 'aria-label': text.stepStatus, onChange: change('status') },
      STATUSES.map((s) => h('option', { key: s, value: s }, text[STATUS_LABEL[s]]))),
    h('div', { className: 'lrn-edit-tools' },
      tool(text.moveUp, icons.up, () => move(index, -1), index === 0),
      tool(text.moveDown, icons.down, () => move(index, 1), index === count - 1),
      tool(text.removeStep, icons.trash, remove, false)));
}

function NodesEditor({ rows, onChange }) {
  const { React, text, icons, parts, host } = c;
  const list = React.useRef(null);
  host.motion.useFlip(list);
  const move = (i, by) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return h('div', { className: 'lrn-field' },
    h('span', { className: 'lrn-label' }, text.roadmap),
    h('ol', { ref: list, className: 'lrn-edit-nodes' }, rows.map((row, i) => h(NodeEditor, {
      key: row.key, row, index: i, count: rows.length, move,
      set: (next) => onChange(rows.map((r) => (r.key === row.key ? next : r))),
      remove: () => onChange(rows.filter((r) => r.key !== row.key)),
    }))),
    h('div', null, h(parts.Button, { icon: icons.plus, onClick: () => onChange([...rows, { key: `new-${++draftKey}`, title: '', summary: '', status: 'todo' }]) }, text.addStep)));
}

/** The form for a new track and for an existing one's settings. */
function TrackForm({ track, saveLabel, onSave, onCancel }) {
  const { React, text, parts, icons } = c;
  const [draft, setDraft] = React.useState(() => draftOf(track ?? {}));
  const [busy, setBusy] = React.useState(false);
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });
  const save = () => {
    setBusy(true);
    void Promise.resolve(onSave(fieldsOf(draft))).catch(c.host.toastError).finally(() => setBusy(false));
  };
  return h('form', { className: 'lrn-form', 'data-testid': 'learn-form', onSubmit: (e) => { e.preventDefault(); save(); } },
    h(Field, { id: 'lrn-f-title', label: text.fieldTitle }, h('input', { id: 'lrn-f-title', className: 'lrn-input', value: draft.title, onChange: set('title'), autoFocus: !track })),
    h(Field, { id: 'lrn-f-goal', label: text.fieldGoal }, h('textarea', { id: 'lrn-f-goal', className: 'lrn-input', rows: 2, value: draft.goal, onChange: set('goal') })),
    h('div', { className: 'lrn-form-row' },
      h(Field, { id: 'lrn-f-level', label: text.fieldLevel }, h('input', { id: 'lrn-f-level', className: 'lrn-input', value: draft.level, placeholder: text.fieldLevelHint, onChange: set('level') })),
      h(Field, { id: 'lrn-f-lang', label: text.fieldLanguage }, h('select', { id: 'lrn-f-lang', className: 'lrn-input lrn-select', value: draft.language, onChange: set('language') },
        LANGUAGES.map((l) => h('option', { key: l, value: l }, text[`lang_${l}`]))))),
    h(Field, { id: 'lrn-f-style', label: text.fieldStyle }, h('textarea', { id: 'lrn-f-style', className: 'lrn-input', rows: 4, value: draft.style, placeholder: text.fieldStyleHint, onChange: set('style') })),
    h(NodesEditor, { rows: draft.nodes, onChange: (nodes) => setDraft({ ...draft, nodes }) }),
    h('div', { className: 'lrn-row-end' },
      h(parts.Button, { onClick: onCancel }, text.cancel),
      h(parts.Button, { kind: 'primary', icon: icons.check, type: 'submit', disabled: busy || !draft.title.trim() }, saveLabel)));
}
