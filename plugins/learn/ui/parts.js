// Small pieces every view of the screen uses.
import { fill } from './strings.js';
import { streakOf } from './data.js';

const cx = (...names) => names.filter(Boolean).join(' ');

export function makeParts({ h, text, icons, data }) {
  function Button({ kind = 'ghost', icon: Icon, children, className, ...rest }) {
    return h('button', { type: 'button', className: cx('lrn-btn press', `lrn-btn-${kind}`, className), ...rest }, Icon && h(Icon, { size: 13 }), children);
  }

  /** Done of total as a bar that grows to its new length. */
  function Bar({ done, total, className }) {
    const share = total ? done / total : 0;
    return h('div', { className: cx('lrn-bar', className), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
      h('div', { className: 'lrn-bar-fill', style: { transform: `scaleX(${share})` } }));
  }

  function Streak() {
    const n = streakOf(data.useActivity().days);
    return h('span', { className: cx('lrn-chip', n > 0 && 'is-hot'), title: n > 0 ? fill(text.streak, { n }) : text.streakNone, 'data-testid': 'learn-streak' },
      h(icons.flame, { size: 13 }), n);
  }

  function Header({ title, onBack, backLabel, children }) {
    return h('header', { className: 'lrn-head' },
      onBack && h('button', { type: 'button', className: 'lrn-icon-btn press', 'aria-label': backLabel ?? text.back, title: backLabel ?? text.back, onClick: onBack }, h(icons.back, { size: 15 })),
      h('h1', { className: 'lrn-title' }, title),
      h('div', { className: 'lrn-head-tools' }, children));
  }

  return { Button, Bar, Streak, Header, cx };
}
