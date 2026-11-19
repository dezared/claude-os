// Search and filters over a board: text in the id, title, description and labels; project, type, assignee, label.
import { GENERAL, TYPES } from './data.js';
import { TypeMark, icon } from './card.js';

export const ANY_PROJECT = '@any';
export const NO_FILTER = { q: '', project: ANY_PROJECT, types: [], who: 'any', label: null };

export const filtering = (f) => f.q.trim() !== '' || f.project !== ANY_PROJECT || f.types.length > 0 || f.who !== 'any' || f.label !== null;

const inProject = (card, project) => project === ANY_PROJECT || (project === GENERAL ? card.project === null : card.project === project);

const WHO = {
  any: () => true,
  me: (c) => c.assignee === 'user',
  agent: (c) => !!c.agent,
  none: (c) => !c.agent && !c.assignee,
};

function matchesText(card, q) {
  if (!q) return true;
  return [card.id, card.title, card.description, ...card.labels].some((s) => s.toLowerCase().includes(q));
}

export function applyFilters(cards, f) {
  const q = f.q.trim().toLowerCase();
  return cards.filter((c) => matchesText(c, q)
    && inProject(c, f.project)
    && (f.types.length === 0 || f.types.includes(c.type))
    && WHO[f.who](c)
    && (f.label === null || c.labels.includes(f.label)));
}

const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function Chips({ kit, values, chosen, mark, label, names, onChange }) {
  const h = kit.h;
  return h('div', { role: 'group', 'aria-label': label, className: 'kp-chips' }, values.map((v) => h('button', {
    key: v, type: 'button', 'aria-pressed': chosen.includes(v), title: kit.t(`${names}.${v}`),
    className: `kp-chip${chosen.includes(v) ? ' kp-on' : ''}`, onClick: () => onChange(toggle(chosen, v)),
  }, mark(kit, v))));
}

export function FilterBar({ kit, filters, setFilters, labels, projects, searchRef }) {
  const h = kit.h;
  const set = (patch) => setFilters({ ...filters, ...patch });
  const { Input, Select, ProjectSelect, Button } = kit.ui;
  const { Pop } = kit.motion;
  return h('div', { className: 'kp-filters' },
    h('label', { className: 'kp-search' }, icon(kit, 'Search', { size: 12 }),
      h(Input, { ref: searchRef, 'aria-label': kit.t('filter.search'), placeholder: kit.t('filter.searchHint'), value: filters.q, onChange: (e) => set({ q: e.target.value }), onKeyDown: (e) => e.key === 'Escape' && e.currentTarget.blur() })),
    h(ProjectSelect, { ariaLabel: kit.t('filter.project'), className: 'kp-select-wide', value: filters.project, onChange: (project) => set({ project: project ?? ANY_PROJECT }), projects, extra: [{ value: ANY_PROJECT, label: kit.t('filter.anyProject') }, { value: GENERAL, label: kit.t('filter.noProject') }] }),
    h(Chips, { kit, values: TYPES, chosen: filters.types, mark: TypeMark, names: 'type', label: kit.t('filter.type'), onChange: (types) => set({ types }) }),
    h(Select, { ariaLabel: kit.t('filter.who'), className: 'kp-select', value: filters.who, onChange: (who) => set({ who }), options: ['any', 'me', 'agent', 'none'].map((v) => ({ value: v, label: kit.t(`filter.who.${v}`) })) }),
    labels.length ? h(Select, { ariaLabel: kit.t('filter.label'), className: 'kp-select', value: filters.label, onChange: (label) => set({ label }), options: [{ value: null, label: kit.t('filter.anyLabel') }, ...labels.map((l) => ({ value: l, label: l }))] }) : null,
    h(Pop, { show: filtering(filters), fade: true }, h(Button, { size: 'sm', onClick: () => setFilters(NO_FILTER) }, icon(kit, 'X', { size: 12 }), kit.t('filter.clear'))));
}
