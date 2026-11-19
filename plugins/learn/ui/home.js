// The list of tracks, a new one, and the course plugins of the user's that can become one.
import { fill } from './strings.js';
import { statusesOf } from './data.js';
import { importPrompt, newTrackPrompt } from './prompts.js';

// A user plugin that reads like a course. Only offered: nothing is imported until the user asks.
const COURSE = /course|lesson|tutor|learn|курс|урок|обучени/i;
const looksLikeCourse = (row) => row.source === 'user' && row.id !== 'learn' && row.contains?.skills?.length > 0 && COURSE.test(`${row.id} ${row.name} ${row.description ?? ''}`);

// Bound once by activate(): React, the host, the strings and the shared parts.
let c;
const h = (...args) => c.React.createElement(...args);

export function makeHome(ctx) {
  c = ctx;
  return Home;
}

/** Before a track exists its chat needs a folder too: the plugin's workspace. */
export async function chatInWorkspace(title, prompt) {
  const cwd = await c.data.workspace().catch(c.host.toastError);
  if (cwd) await c.host.openChat({ cwd, title, prompt });
}

function TrackCard({ id, onOpen }) {
  const { text, data, parts } = c;
  const track = data.useTrack(id).data;
  const progress = data.useProgress(id);
  if (!track) return null;
  const statuses = statusesOf(track, progress);
  const done = Object.values(statuses).filter((s) => s === 'done').length;
  const next = track.nodes.find((n) => statuses[n.id] === 'current');
  return h('button', { type: 'button', className: 'lrn-card press', 'data-flip': id, 'data-testid': 'learn-track', onClick: () => onOpen(id) },
    h('span', { className: 'lrn-card-title' }, track.title),
    h('span', { className: 'lrn-card-goal' }, track.goal),
    h(parts.Bar, { done, total: track.nodes.length }),
    h('span', { className: 'lrn-card-foot' },
      h('span', null, fill(text.progress, { done, total: track.nodes.length })),
      h('span', { className: 'lrn-card-next' }, next ? fill(text.next, { title: next.title }) : text.finished)));
}

function NewTrack({ open, onClose }) {
  const { React, text, icons, parts, host } = c;
  const [topic, setTopic] = React.useState('');
  const start = () => {
    if (!topic.trim()) return;
    void chatInWorkspace(text.title, newTrackPrompt(topic)).then(onClose);
  };
  return h(host.motion.Fold, { show: open },
    h('div', { className: 'lrn-new' },
      h('label', { className: 'lrn-label', htmlFor: 'lrn-topic' }, text.newPrompt),
      h('textarea', { id: 'lrn-topic', className: 'lrn-input', rows: 2, placeholder: text.newPlaceholder, value: topic, onChange: (e) => setTopic(e.target.value), onKeyDown: (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && start() }),
      h('div', { className: 'lrn-row-end' },
        h(parts.Button, { onClick: onClose }, text.cancel),
        h(parts.Button, { kind: 'primary', icon: icons.sparkles, disabled: !topic.trim(), onClick: start }, text.newGo))));
}

/** Course plugins not imported yet: a track whose source names the plugin counts as imported. */
function useOffers(ids) {
  const { React, host } = c;
  const rows = host.useApi('/api/os-plugins', ['osPlugins']).data?.rows ?? [];
  const [sources, setSources] = React.useState([]);
  React.useEffect(() => {
    let stale = false;
    Promise.all(ids.map((id) => host.api(`/api/os-plugins/learn/data/tracks/${encodeURIComponent(id)}/track.json`).catch(() => null)))
      .then((tracks) => !stale && setSources(tracks.map((t) => t?.source ?? '').filter(Boolean)));
    return () => {
      stale = true;
    };
  }, [ids.join('\n')]);
  return rows.filter((r) => looksLikeCourse(r) && !sources.some((s) => s.includes(r.path) || s.includes(r.id)));
}

function Offers({ ids }) {
  const { text, icons, parts } = c;
  const offers = useOffers(ids);
  if (offers.length === 0) return null;
  return h('section', { className: 'lrn-offers', 'aria-label': text.importTitle },
    h('h2', { className: 'lrn-section' }, text.importTitle),
    offers.map((p) => h('div', { key: p.id, className: 'lrn-offer', 'data-testid': 'learn-offer' },
      h(icons.download, { size: 16, className: 'lrn-offer-icon' }),
      h('span', { className: 'lrn-offer-text' }, fill(text.importBody, { name: p.name })),
      h(parts.Button, { kind: 'primary', onClick: () => void chatInWorkspace(p.name, importPrompt(p)) }, text.importGo))));
}

/** A course made by hand: the user writes the settings and the roadmap, Claude writes lessons later. */
function ManualTrack({ open, ids, onClose, onOpen }) {
  const { text, data, host, TrackForm } = c;
  const save = async (fields) => onOpen(await data.createTrack(fields, new Set(ids)));
  return h(host.motion.Fold, { show: open }, open && h('div', { className: 'lrn-new' }, h(TrackForm, { saveLabel: text.create, onSave: save, onCancel: onClose })));
}

function Home({ onOpen }) {
  const { React, text, icons, data, parts, host } = c;
  const { ids, loading } = data.useTrackIds();
  const [adding, setAdding] = React.useState(false);
  const [manual, setManual] = React.useState(false);
  const grid = React.useRef(null);
  host.motion.useFlip(grid);
  return h('div', { className: 'lrn-page' },
    h(parts.Header, { title: text.title },
      h(parts.Streak),
      h(parts.Button, { icon: icons.sliders, onClick: () => { setManual(true); setAdding(false); }, 'aria-expanded': manual }, text.newManual),
      h(parts.Button, { kind: 'primary', icon: icons.plus, onClick: () => { setAdding(true); setManual(false); }, 'aria-expanded': adding }, text.newTrack)),
    h('p', { className: 'lrn-lead' }, text.lead),
    h(NewTrack, { open: adding, onClose: () => setAdding(false) }),
    h(ManualTrack, { open: manual, ids, onClose: () => setManual(false), onOpen }),
    h(Offers, { ids }),
    !loading && ids.length === 0 && h('p', { className: 'lrn-empty' }, text.empty),
    h('div', { ref: grid, className: 'lrn-grid' }, ids.map((id) => h(TrackCard, { key: id, id, onOpen }))));
}
