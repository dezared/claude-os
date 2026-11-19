import { useEffect, useRef, useState } from 'react';

/** The motion tokens of styles.css, for the animations started from code. */
export const EASE_UI = 'cubic-bezier(0.23, 1, 0.32, 1)'; // --ease-ui
/** How long a small thing takes to leave: the exit transitions of .motion-pop, .motion-fade and the closing popovers. */
export const LEAVE_MS = 160;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Keeps a thing on screen for its exit: `mounted` stays true for `ms` after `show` turns false, with `leaving` set meanwhile,
 * so the leaving class can play before it unmounts. Showing it again during the exit takes it back at once.
 */
export function usePresence(show: boolean, ms = LEAVE_MS): { mounted: boolean; leaving: boolean } {
  const [kept, setKept] = useState(show);
  if (show && !kept) setKept(true);
  useEffect(() => {
    if (show) return;
    if (reducedMotion()) return setKept(false);
    const timer = window.setTimeout(() => setKept(false), ms);
    return () => clearTimeout(timer);
  }, [show, ms]);
  return { mounted: show || kept, leaving: !show && kept };
}

/** The last value that was not null: what a closing dialog keeps showing while it leaves, after its subject is already gone. */
export function useLast<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return last.current;
}
