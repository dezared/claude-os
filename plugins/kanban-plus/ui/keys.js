// The board's keys, while it is on screen and nothing else has the keyboard: a field, an open dialog, a menu.
const typing = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
const busy = () => !!document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');

function stepBoard(s, by) {
  const order = s.boards.map((x) => x.id);
  const at = Math.max(0, order.indexOf(s.board?.id));
  if (order.length) s.setBoard(order[(at + by + order.length) % order.length]);
}

function actions({ s, d, searchRef }) {
  return {
    '/': () => searchRef.current?.focus(),
    n: () => d.open({ kind: 'new' }),
    1: () => s.setView('board'),
    2: () => s.setView('list'),
    '[': () => stepBoard(s, -1),
    ']': () => stepBoard(s, 1),
    '?': () => d.open({ kind: 'keys' }),
  };
}

export function useShortcuts(kit, state) {
  const latest = kit.React.useRef(state);
  latest.current = state;
  kit.React.useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement) || busy()) return;
      const run = actions(latest.current)[e.key.toLowerCase()];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
