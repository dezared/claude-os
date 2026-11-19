// The lower half of a card: its comments, its log and the sessions it was worked in with what they spent.
import { icon } from './card.js';
import { boardName, cardUrl, send } from './data.js';

const whoName = (kit, by) => (by === 'user' ? kit.t('who.you') : by);

function Comments({ kit, card, log }) {
  const h = kit.h;
  const [text, setText] = kit.React.useState('');
  const [busy, setBusy] = kit.React.useState(false);
  const comments = log.filter((a) => a.kind === 'comment');
  const post = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await send(kit, `${cardUrl(card.id)}/comments`, 'POST', { text })) setText('');
    setBusy(false);
  };
  return h('div', { className: 'kp-thread' },
    comments.length === 0 ? h('p', { className: 'kp-empty' }, kit.t('comments.empty')) : null,
    h('ul', { className: 'kp-comments' }, comments.map((c) => h('li', { key: c.id, className: 'kp-comment kp-enter' },
      h('div', { className: 'kp-comment-head' }, icon(kit, c.by === 'user' ? 'User' : 'Bot', { size: 12 }), h('b', null, whoName(kit, c.by)), h('span', { className: 'kp-dim' }, kit.format.fmtAgo(c.at))),
      h(kit.ui.Markdown, { text: c.text, small: true })))),
    h('div', { className: 'kp-composer' },
      h(kit.ui.Textarea, { 'aria-label': kit.t('comments.new'), rows: 2, placeholder: kit.t('comments.placeholder'), value: text, onChange: (e) => setText(e.target.value), onKeyDown: (e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? void post() : null) }),
      h(kit.ui.Button, { variant: 'primary', size: 'sm', disabled: !text.trim() || busy, onClick: () => void post() }, kit.t('comments.send'))));
}

const col = (kit, c) => (c ? kit.t(`col.${c}`) : '');
const DESCRIBE = {
  moved: (kit, a) => kit.t('log.moved', { from: col(kit, a.from), to: col(kit, a.to) }),
  created: (kit, a) => kit.t('log.created', { to: col(kit, a.to) }),
  taken: (kit) => kit.t('log.taken'),
  board: (kit, a, boards) => kit.t('log.board', { to: boardName(kit, boards.find((b) => b.id === a.to)) || a.to }),
  sprint: (kit, a) => (a.to ? kit.t('log.sprintTo', { to: a.to }) : kit.t('log.sprintOut')), // written before boards replaced sprints
  edited: (kit, a) => kit.t('log.edited', { fields: (a.fields ?? []).map((f) => kit.t(`field.${f}`)).join(', ') }),
  comment: (kit) => kit.t('log.comment'),
};
const describe = (kit, a, boards) => DESCRIBE[a.kind]?.(kit, a, boards) ?? a.kind;

function Activity({ kit, log, boards }) {
  const h = kit.h;
  if (log.length === 0) return h('p', { className: 'kp-empty' }, kit.t('log.empty'));
  return h('ol', { className: 'kp-log' }, log.slice().reverse().map((a) => h('li', { key: a.id, className: 'kp-log-line kp-enter' },
    icon(kit, a.by === 'user' ? 'User' : 'Bot', { size: 12 }),
    h('span', null, h('b', null, whoName(kit, a.by)), ' ', describe(kit, a, boards)),
    a.session ? h('span', { className: 'kp-dim kp-mono', title: kit.t('log.session') }, a.session.slice(0, 8)) : null,
    h('span', { className: 'kp-push kp-dim', title: kit.format.fmtDateTime(a.at) }, kit.format.fmtAgo(a.at)))));
}

function Sessions({ kit, sessions }) {
  const h = kit.h;
  const showCost = kit.useShowCost();
  if (sessions.length === 0) return h('p', { className: 'kp-empty' }, kit.t('sessions.empty'));
  const tokens = sessions.reduce((n, s) => n + s.tokens, 0);
  const cost = sessions.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const open = (s) => (s.tab ? kit.go({ kind: 'tab', id: s.tab }) : void kit.tabs.openSession(s));
  return h('div', null,
    h('p', { className: 'kp-usage' }, icon(kit, 'Coins', { size: 12 }), kit.t('sessions.total', { tokens: kit.format.fmtTokens(tokens) }), showCost && cost > 0 ? ` · ${kit.format.fmtUsd(cost)}` : ''),
    h('ul', { className: 'kp-sessions' }, sessions.map((s) => h('li', { key: s.id }, h('button', { type: 'button', className: 'kp-session', onClick: () => open(s) },
      icon(kit, s.tab ? 'Bot' : 'History', { size: 12, className: s.working ? 'kp-working' : '' }),
      h('span', { className: 'kp-truncate' }, s.title ?? s.id),
      h('span', { className: 'kp-push kp-dim' }, kit.format.fmtTokens(s.tokens), showCost && s.costUsd ? ` · ${kit.format.fmtUsd(s.costUsd)}` : '', ' · ', kit.format.fmtAgo(s.lastActivity)))))));
}

const TABS = ['comments', 'activity', 'sessions'];

/** Comments first: they are what people come back to read. */
export function CardLog({ kit, card, log, sessions, boards }) {
  const h = kit.h;
  const [tab, setTab] = kit.React.useState('comments');
  const count = { comments: log.filter((a) => a.kind === 'comment').length, activity: log.length, sessions: sessions.length };
  return h('div', { className: 'kp-log-box' },
    h(kit.ui.Segmented, { ariaLabel: kit.t('tab.aria'), value: tab, onChange: setTab, options: TABS.map((v) => ({ value: v, label: `${kit.t(`tab.${v}`)} ${count[v] || ''}`.trim() })) }),
    h('div', { key: tab, className: 'kp-fade' },
      tab === 'comments' ? h(Comments, { kit, card, log }) : null,
      tab === 'activity' ? h(Activity, { kit, log, boards }) : null,
      tab === 'sessions' ? h(Sessions, { kit, sessions }) : null));
}
