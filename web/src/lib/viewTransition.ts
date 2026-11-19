import { flushSync } from 'react-dom';

type Place = { kind: string };

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Moves between Home and a screen through the browser's view transition: a snapshot of the old view fades into the live new one
 * on the compositor, so the move stays smooth however long the new screen takes to render. Other moves apply at once.
 */
export function moveView(from: Place, to: Place, apply: () => void): void {
  const crossesHome = (from.kind === 'home') !== (to.kind === 'home');
  if (!crossesHome || reduced.matches || !document.startViewTransition) return apply();
  // flushSync: the new view, with its layout effects (body.on-home), must be in the DOM when the browser captures it.
  document.startViewTransition(() => flushSync(apply));
}
