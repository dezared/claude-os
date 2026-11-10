import type { PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';

const TOP_BAR = 52; // the title bar stays reachable

export interface FloatPos {
  left: number;
  bottom: number;
}

interface Saved {
  floating: boolean;
  collapsed: boolean;
  pos: FloatPos | null; // null: not moved yet, the lower right corner
}

/** A panel that can leave its place and float: remembered under its own key. */
function floatStore(key: string) {
  const read = (): Saved => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Saved> | null;
      const pos = saved?.pos;
      return {
        floating: saved?.floating === true,
        collapsed: saved?.collapsed === true,
        pos: pos && Number.isFinite(pos.left) && Number.isFinite(pos.bottom) ? pos : null,
      };
    } catch {
      return { floating: false, collapsed: false, pos: null };
    }
  };
  const use = create<Saved>(read);
  const update = (patch: Partial<Saved>) => {
    use.setState(patch);
    const { floating, collapsed, pos } = use.getState();
    localStorage.setItem(key, JSON.stringify({ floating, collapsed, pos }));
  };
  return {
    use,
    setFloating: (floating: boolean) => update({ floating }),
    setPos: (pos: FloatPos) => update({ pos }),
    setCollapsed: (collapsed: boolean) => {
      if (use.getState().collapsed !== collapsed) update({ collapsed });
    },
  };
}

export const plannerFloat = floatStore('claude-os.plannerFloat');

/** Where a panel of this size stands for a wanted position: entirely on screen, under the title bar. */
export function clampFloat(pos: FloatPos | null, width: number, height: number): FloatPos {
  const wanted = pos ?? { left: innerWidth - width - 16, bottom: 56 };
  return {
    left: Math.max(8, Math.min(wanted.left, innerWidth - width - 8)),
    bottom: Math.max(8, Math.min(wanted.bottom, innerHeight - height - TOP_BAR)),
  };
}

/** Moves a floating panel by its handle. Anchored by the lower left corner; the position is saved when the drag ends. */
export function dragFloat(e: ReactPointerEvent<HTMLElement>, el: HTMLElement | null, save: (pos: FloatPos) => void) {
  if (e.button !== 0 || !el || (e.target as Element).closest('button')) return;
  const handle = e.currentTarget;
  const box = el.getBoundingClientRect();
  const fromLeft = e.clientX - box.left;
  const fromBottom = box.bottom - e.clientY;
  let pos = { left: box.left, bottom: innerHeight - box.bottom };
  handle.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    pos = clampFloat({ left: ev.clientX - fromLeft, bottom: innerHeight - ev.clientY - fromBottom }, box.width, box.height);
    el.style.left = `${pos.left}px`;
    el.style.bottom = `${pos.bottom}px`;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    save(pos);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}
