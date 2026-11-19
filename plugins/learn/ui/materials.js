// A course's own materials (a program, a page template, notes): kept with the track, read by Claude before each lesson.
import { uniqueId } from './data.js';

const KINDS = ['markdown', 'html', 'text'];

let c;
const h = (...args) => c.React.createElement(...args);

export function makeMaterials(ctx) {
  c = ctx;
  return Materials;
}

function MaterialForm({ material, onSave, onCancel }) {
  const { React, text, parts, icons } = c;
  const [draft, setDraft] = React.useState({ title: material?.title ?? '', kind: material?.kind ?? 'markdown', content: material?.content ?? '' });
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });
  const ready = draft.title.trim() && draft.content.trim();
  return h('form', { className: 'lrn-form', 'data-testid': 'learn-material-form', onSubmit: (e) => { e.preventDefault(); if (ready) onSave(draft); } },
    h('div', { className: 'lrn-form-row' },
      h('input', { className: 'lrn-input', value: draft.title, placeholder: text.materialTitle, 'aria-label': text.materialTitle, onChange: set('title'), autoFocus: true }),
      h('select', { className: 'lrn-input lrn-select', value: draft.kind, 'aria-label': text.materialKind, onChange: set('kind') }, KINDS.map((k) => h('option', { key: k, value: k }, text[`kind_${k}`])))),
    h('textarea', { className: 'lrn-input lrn-mono', rows: 10, value: draft.content, placeholder: text.materialContent, 'aria-label': text.materialContent, onChange: set('content') }),
    h('div', { className: 'lrn-row-end' },
      h(parts.Button, { onClick: onCancel }, text.cancel),
      h(parts.Button, { kind: 'primary', icon: icons.check, type: 'submit', disabled: !ready }, text.save)));
}

function MaterialBody({ material }) {
  const { host } = c;
  if (material.kind === 'html') return h(host.HtmlFrame, { html: material.content, title: material.title, className: 'lrn-frame lrn-frame-sm' });
  if (material.kind === 'markdown') return h('div', { className: 'lrn-material-text' }, h(host.ui.Markdown, { text: material.content }));
  return h('pre', { className: 'lrn-material-text lrn-mono' }, material.content);
}

function MaterialRow({ track, id }) {
  const { React, text, icons, data, host } = c;
  const material = data.useMaterial(track.id, id);
  const [mode, setMode] = React.useState(null);
  const [confirm, setConfirm] = React.useState(false);
  if (!material) return null;
  const toggle = (next) => setMode(mode === next ? null : next);
  const tool = (label, icon, onClick, extra) => h('button', { type: 'button', className: 'lrn-icon-btn press', 'aria-label': label, title: label, onClick, ...extra }, h(icon, { size: 13 }));
  return h('li', { className: 'lrn-material', 'data-flip': id, 'data-testid': 'learn-material' },
    h('div', { className: 'lrn-material-head' },
      h('button', { type: 'button', className: 'lrn-node-title press', 'aria-expanded': mode === 'view', onClick: () => toggle('view') }, material.title),
      h('span', { className: 'lrn-badge' }, text[`kind_${material.kind}`] ?? material.kind),
      h('span', { className: 'lrn-material-tools' },
        tool(text.edit, icons.pencil, () => toggle('edit')),
        confirm
          ? h('button', { type: 'button', className: 'lrn-btn lrn-btn-danger press', onClick: () => void data.deleteMaterial(track.id, id) }, text.deleteYes)
          : tool(text.deleteMaterial, icons.trash, () => setConfirm(true), { onBlur: () => setConfirm(false) }))),
    h(host.motion.Fold, { show: mode === 'view' }, h(MaterialBody, { material })),
    h(host.motion.Fold, { show: mode === 'edit' }, mode === 'edit' && h(MaterialForm, {
      material, onCancel: () => setMode(null),
      onSave: (draft) => void data.saveMaterial(track.id, id, draft).then(() => setMode(null)),
    })));
}

function Materials({ track }) {
  const { React, text, icons, data, parts, host } = c;
  const ids = data.useMaterialIds(track.id);
  const [adding, setAdding] = React.useState(false);
  const list = React.useRef(null);
  host.motion.useFlip(list);
  const add = (draft) => void data.saveMaterial(track.id, uniqueId(draft.title, new Set(ids), 'material'), draft).then(() => setAdding(false));
  return h('section', { 'aria-label': text.materials, 'data-testid': 'learn-materials' },
    h('div', { className: 'lrn-section-head' },
      h('h2', { className: 'lrn-section' }, text.materials),
      h(parts.Button, { icon: icons.plus, onClick: () => setAdding(true), 'aria-expanded': adding }, text.addMaterial)),
    h(host.motion.Fold, { show: adding }, adding && h(MaterialForm, { onSave: add, onCancel: () => setAdding(false) })),
    ids.length === 0 && !adding && h('p', { className: 'lrn-dim' }, text.noMaterials),
    h('ul', { ref: list, className: 'lrn-materials' }, ids.map((id) => h(MaterialRow, { key: id, track, id }))));
}
