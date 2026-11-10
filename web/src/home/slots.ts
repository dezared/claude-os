import type { HomeLayout, HomeSlot, WidgetBox, WidgetDef } from '@/lib/types';
import { HOME_SLOTS as SLOTS } from '../../../shared/contract.ts';

export { SLOTS };

export type BuiltinId = 'projects' | 'tokens' | 'stats' | 'notes' | 'progress';

/** The widgets the home screen starts with. They live by the same rules as a user's block; only their view is code. */
export const BUILTIN_SLOT: Record<BuiltinId, HomeSlot> = { projects: 'left', tokens: 'right', stats: 'bottom-left', notes: 'top', progress: 'right' };

export const EMPTY_HOME: HomeLayout = { slots: {}, hidden: [] };

export type Stacks = Record<HomeSlot, string[]>;

type Size = { width: number; height: number };

/** An old box finds the slot whose middle stands closest to its own. Only read: the entry keeps the box until it is moved. */
export function nearestSlot(box: WidgetBox, size: Size): HomeSlot {
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  const middles: Record<HomeSlot, [number, number]> = {
    left: [0.1, 0.25],
    right: [0.9, 0.25],
    top: [0.5, 0.15],
    'bottom-left': [0.1, 0.75],
    'bottom-right': [0.9, 0.75],
  };
  let best: HomeSlot = 'right';
  let least = Infinity;
  for (const slot of SLOTS) {
    const d = Math.hypot(x - middles[slot][0] * size.width, y - middles[slot][1] * size.height);
    if (d < least) {
      least = d;
      best = slot;
    }
  }
  return best;
}

/**
 * What stands where, hidden ones included. The slot in a widget's entry wins, because that is what Claude edits;
 * otherwise the layout decides, then the built-in default or the old box. The layout gives the order, newcomers go last.
 */
export function stacks(home: HomeLayout, defs: WidgetDef[], size: Size): Stacks {
  const listed = new Map<string, HomeSlot>();
  for (const slot of SLOTS) for (const id of home.slots[slot] ?? []) listed.set(id, slot);
  const where = new Map<string, HomeSlot>();
  for (const id of Object.keys(BUILTIN_SLOT) as BuiltinId[]) if (!home.removed?.includes(id)) where.set(id, listed.get(id) ?? BUILTIN_SLOT[id]);
  for (const d of defs) {
    const slot = d.slot ?? listed.get(d.id) ?? (d.box && nearestSlot(d.box, size));
    if (slot) where.set(d.id, slot);
  }
  const out = Object.fromEntries(SLOTS.map((s) => [s, (home.slots[s] ?? []).filter((id) => where.get(id) === s)])) as Stacks;
  for (const [id, slot] of where) if (!out[slot].includes(id)) out[slot].push(id);
  return out;
}

/** The layout with one widget moved: into `slot`, right before `before`, or last. */
export function moved(all: Stacks, id: string, slot: HomeSlot, before: string | null): Stacks {
  const out = Object.fromEntries(SLOTS.map((s) => [s, all[s].filter((x) => x !== id)])) as Stacks;
  const at = before === null ? -1 : out[slot].indexOf(before);
  out[slot].splice(at < 0 ? out[slot].length : at, 0, id);
  return out;
}

export const sameStacks = (a: Stacks, b: Stacks) => SLOTS.every((s) => a[s].join('\0') === b[s].join('\0'));

/** Where the arrow keys go from a slot. */
export const NEIGHBOUR: Record<HomeSlot, Partial<Record<'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', HomeSlot>>> = {
  left: { ArrowRight: 'top', ArrowDown: 'bottom-left' },
  top: { ArrowLeft: 'left', ArrowRight: 'right' },
  right: { ArrowLeft: 'top', ArrowDown: 'bottom-right' },
  'bottom-left': { ArrowUp: 'left', ArrowRight: 'bottom-right' },
  'bottom-right': { ArrowUp: 'right', ArrowLeft: 'bottom-left' },
};

export type Zone = { slot: HomeSlot; left: number; top: number; right: number; bottom: number };

const ZONE_MIN = 72;
const ZONE_MIN_WIDTH = 240;
const ZONE_GAP = 5;

/** A side column holds two slots: it is cut in half, or where what already stands there needs the line to be. */
function columnZones(col: Element): Zone[] {
  const style = getComputedStyle(col);
  const r = col.getBoundingClientRect();
  const left = r.left + parseFloat(style.paddingLeft);
  const right = r.right - parseFloat(style.paddingRight);
  const top = r.top + parseFloat(style.paddingTop);
  const bottom = r.bottom - parseFloat(style.paddingBottom);
  const [upper, lower] = [...col.querySelectorAll<HTMLElement>(':scope > [data-slot]')];
  const upperEnd = upper.lastElementChild?.getBoundingClientRect().bottom ?? top;
  const lowerStart = lower.firstElementChild?.getBoundingClientRect().top ?? bottom;
  const middle = (top + bottom) / 2;
  const wanted = upperEnd > middle ? upperEnd : lowerStart < middle ? lowerStart : middle;
  const cut = Math.max(top + ZONE_MIN, Math.min(wanted, bottom - ZONE_MIN));
  return [
    { slot: upper.dataset.slot as HomeSlot, left, right, top, bottom: cut - ZONE_GAP },
    { slot: lower.dataset.slot as HomeSlot, left, right, top: cut + ZONE_GAP, bottom },
  ];
}

/** The slots as drop targets. An empty slot has no height of its own: it gets one, growing away from the window's edge. */
export function measureZones(root: Element): Zone[] {
  const cols = [...root.querySelectorAll('.home-col')].filter((c) => getComputedStyle(c).display !== 'contents');
  const zones = cols.flatMap(columnZones);
  const free = SLOTS.filter((slot) => !zones.some((z) => z.slot === slot));
  return [
    ...zones,
    ...free.flatMap((slot): Zone[] => {
      const el = root.querySelector(`[data-slot="${slot}"]`);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      const short = Math.max(r.height, ZONE_MIN);
      const bottomSlot = slot.startsWith('bottom');
      return [{ slot, left: r.left, right: Math.max(r.right, r.left + ZONE_MIN_WIDTH), top: bottomSlot ? r.bottom - short : r.top, bottom: bottomSlot ? r.bottom : r.top + short }];
    }),
  ];
}

/** There is no free placement: whatever the point, some slot takes it. */
export function zoneAt(zones: Zone[], x: number, y: number): Zone {
  let best = zones[0];
  let least = Infinity;
  for (const z of zones) {
    const d = Math.hypot(Math.max(z.left - x, 0, x - z.right), Math.max(z.top - y, 0, y - z.bottom));
    if (d < least) {
      least = d;
      best = z;
    }
  }
  return best;
}
