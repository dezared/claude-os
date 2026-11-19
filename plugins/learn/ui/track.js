// One track: its goal, progress and the roadmap, each node opening its lesson or asking Claude for one.
import { fill } from './strings.js';
import { statusesOf } from './data.js';
import { lessonPrompt, roadmapPrompt } from './prompts.js';

let c;
const h = (...args) => c.React.createElement(...args);

export function makeTrack(ctx) {
  c = ctx;
  return Track;
}

/** A tab in the track's work folder: lessons and practice happen where the exercises live. A folder ~/learn/<name> that a
 * track made on the screen or moved from elsewhere does not have yet is made first: a tab needs a folder that exists. */
export async function chatInTrack(track, title, prompt) {
  const name = String(track.workdir ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? track.id;
  const made = await c.data.workspace(name).catch(() => null);
  await c.host.openChat({ cwd: track.workdir ?? made, title, prompt });
}

const STATUS_LABEL = { done: 'statusDone', current: 'statusCurrent', skipped: 'statusSkipped', todo: 'statusTodo' };

function NodeRow({ track, node, status, hasLesson, onOpen }) {
  const { text, icons, parts } = c;
  const open = () => onOpen(node.id);
  return h('li', { className: `lrn-node is-${status}`, 'data-flip': node.id, 'data-testid': 'learn-node' },
    h('span', { className: 'lrn-dot', 'aria-hidden': true }, status === 'done' && h(icons.check, { size: 11 })),
    h('div', { className: 'lrn-node-body' },
      h('button', { type: 'button', className: 'lrn-node-title press', disabled: !hasLesson, onClick: open }, node.title),
      node.summary && h('p', { className: 'lrn-node-summary' }, node.summary),
      h('div', { className: 'lrn-node-meta' },
        h('span', { className: 'lrn-status' }, text[STATUS_LABEL[status]]),
        hasLesson && h('span', { className: 'lrn-badge' }, text.lessonReady))),
    h('div', { className: 'lrn-node-tools' },
      hasLesson
        ? h(parts.Button, { icon: icons.book, onClick: open }, text.open)
        : h(parts.Button, { kind: status === 'current' ? 'primary' : 'ghost', icon: icons.sparkles, onClick: () => void chatInTrack(track, node.title, lessonPrompt(track, node, false)) }, text.write)));
}

function DeleteConfirm({ track, open, onCancel, onDeleted }) {
  const { text, parts, host, data } = c;
  return h(host.motion.Fold, { show: open },
    h('div', { className: 'lrn-confirm', role: 'alert' },
      h('span', null, fill(text.deleteConfirm, { title: track.title })),
      h('div', { className: 'lrn-row-end' },
        h(parts.Button, { onClick: onCancel }, text.cancel),
        h(parts.Button, { kind: 'danger', onClick: () => void data.deleteTrack(track.id).then(onDeleted) }, text.deleteYes))));
}

function Roadmap({ track, progress, onLesson }) {
  const { React, text, data, host } = c;
  const lessons = data.useLessonIds(track.id);
  const statuses = statusesOf(track, progress);
  const list = React.useRef(null);
  host.motion.useFlip(list);
  return h('section', { 'aria-label': text.roadmap },
    h('h2', { className: 'lrn-section' }, text.roadmap),
    track.nodes.length === 0 && h('p', { className: 'lrn-empty' }, text.noSteps),
    h('ol', { ref: list, className: 'lrn-roadmap' },
      track.nodes.map((node) => h(NodeRow, { key: node.id, track, node, status: statuses[node.id], hasLesson: lessons.has(node.id), onOpen: onLesson }))));
}

/** The track's settings and roadmap, edited by hand; ids of kept steps stay, so their lessons and progress do too. */
function Settings({ track, open, onClose }) {
  const { text, data, host, TrackForm } = c;
  const save = (fields) => data.saveTrack(track.id, (now) => ({ ...now, ...fields })).then(onClose);
  return h(host.motion.Fold, { show: open }, open && h('div', { className: 'lrn-new' }, h(TrackForm, { track, saveLabel: text.save, onSave: save, onCancel: onClose })));
}

function Track({ id, onBack, onLesson }) {
  const { React, text, icons, data, parts } = c;
  const { data: track, error } = data.useTrack(id);
  const progress = data.useProgress(id);
  const [deleting, setDeleting] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  if (!track) return h('div', { className: 'lrn-page' }, h(parts.Header, { title: error ? text.trackGone : '…', onBack, backLabel: text.allTracks }));
  const done = Object.values(statusesOf(track, progress)).filter((s) => s === 'done').length;
  return h('div', { className: 'lrn-page' },
    h(parts.Header, { title: track.title, onBack, backLabel: text.allTracks },
      h(parts.Streak),
      h(parts.Button, { icon: icons.sliders, onClick: () => setEditing(!editing), 'aria-expanded': editing }, text.settings),
      h(parts.Button, { icon: icons.map, onClick: () => void chatInTrack(track, track.title, roadmapPrompt(track)) }, text.editMap),
      h('button', { type: 'button', className: 'lrn-icon-btn press', 'aria-label': text.deleteTrack, title: text.deleteTrack, onClick: () => setDeleting(true) }, h(icons.trash, { size: 14 }))),
    h(DeleteConfirm, { track, open: deleting, onCancel: () => setDeleting(false), onDeleted: onBack }),
    h(Settings, { track, open: editing, onClose: () => setEditing(false) }),
    track.goal && h('p', { className: 'lrn-lead' }, track.goal),
    h('div', { className: 'lrn-progress' }, h(parts.Bar, { done, total: track.nodes.length }), h('span', null, fill(text.progress, { done, total: track.nodes.length }))),
    h(Roadmap, { track, progress, onLesson }),
    h(c.Materials, { track }));
}
