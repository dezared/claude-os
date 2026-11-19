// Chromium turns Shift+F10 into a contextmenu event on Windows and Linux, not on macOS: there the same keyboard menu is
// sent here, at the focused element, so every menu stays reachable without a mouse.
export function watchMacMenuKey(): void {
  if (!/Mac/i.test(navigator.platform)) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F10' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const r = el.getBoundingClientRect();
    e.preventDefault();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(r.width / 2, 16), clientY: r.top + r.height / 2 }));
  });
}
