// Kanban+: the board app of Claude OS. Plain modules with no build step: React, the core's components and icons come from the host.
import { makeApp } from './app.js';
import { CSS } from './css.js';
import { makeMentions } from './mention.js';
import { STRINGS } from './strings.js';

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : text);

export function activate(host) {
  const own = STRINGS[host.lang()] ?? STRINGS.en;
  const t = (key, params) => fill(own[key] ?? STRINGS.en[key] ?? key, params);
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const kit = { ...host, t, h: host.React.createElement };
  return {
    screens: [{ id: 'kanban', title: t('title'), icon: host.icons.SquareKanban, component: makeApp(kit), perProject: true }],
    mentions: makeMentions(kit),
    dispose: () => style.remove(),
  };
}
