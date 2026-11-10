// Every project gets its own cosmic colour, stable by key. #d97757 stays the UI accent: the hues around it are not used.
import type { UniverseOptions, UniverseTheme } from '../../lib/types';
import { hash32 } from './layout';

export type Rgb = [number, number, number];

const SLOTS = 18;
export const CORE_COLOR: Rgb = [1, 0.93, 0.78];

function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// Evenly spaced from warm yellow around the wheel, stopping short of the accent orange.
function slotColor(slot: number): Rgb {
  const hue = (38 + (slot * 322) / SLOTS) % 360;
  // Blue and violet read much darker than green at the same lightness.
  const cold = hue > 205 && hue < 300;
  return hsl(hue, 0.88, cold ? 0.79 : 0.7);
}

// Star temperatures, from blue to red, the common ones in the middle.
const TEMPERATURES: Rgb[] = [[0.68, 0.8, 1], [0.86, 0.9, 1], [1, 0.97, 0.9], [1, 0.97, 0.9], [1, 0.9, 0.68], [1, 0.74, 0.5], [1, 0.58, 0.48]];
const TINT = 0.36; // the project's colour keeps the upper hand: a cluster still reads as one project

/** A star's own colour: its project's, warmed or cooled by a temperature that comes from the note's id. */
export function starColor(project: Rgb, id: string): Rgb {
  const t = TEMPERATURES[hash32(id, 33) % TEMPERATURES.length];
  return [project[0] * (1 - TINT) + t[0] * TINT, project[1] * (1 - TINT) + t[1] * TINT, project[2] * (1 - TINT) + t[2] * TINT];
}

const SLOT_COLORS = Array.from({ length: SLOTS }, (_, slot) => slotColor(slot));

export interface Palette {
  of(key: string | null): Rgb;
  css(key: string | null): string;
}

/** Keys on the map go first and take the free slot nearest to their hash, so neighbours in the list never share a hue. */
export function makePalette(mapped: Iterable<string>, coreKey: string | null, chosen: Record<string, string> = {}): Palette {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  const keys = [...new Set(mapped)].filter((k) => k !== coreKey).sort((a, b) => hash32(a, 51) - hash32(b, 51) || a.localeCompare(b));
  for (const key of keys) {
    let slot = hash32(key, 52) % SLOTS;
    for (let i = 0; i < SLOTS && taken.has(slot); i++) slot = (slot + 7) % SLOTS;
    taken.add(slot);
    slots.set(key, slot);
  }
  const of = (key: string | null): Rgb => {
    if (key === coreKey || key === null) return CORE_COLOR;
    return fromHex(chosen[key]) ?? SLOT_COLORS[slots.get(key) ?? hash32(key, 52) % SLOTS];
  };
  return {
    of,
    css(key) {
      const [r, g, b] = of(key);
      return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
    },
  };
}

/** The sky behind the data. A project's own colour never depends on it: rows and stars keep matching everywhere. */
export interface SkyColors {
  bg: Rgb;
  inner: Rgb; // dust and nebulae near the centre
  outer: Rgb; // and at the rim
}

export const THEMES: Record<UniverseTheme, SkyColors> = {
  default: { bg: [0.012, 0.012, 0.018], inner: [1, 0.86, 0.68], outer: [0.6, 0.72, 1] },
  ember: { bg: [0.02, 0.011, 0.01], inner: [1, 0.74, 0.46], outer: [0.95, 0.42, 0.34] },
  aurora: { bg: [0.008, 0.018, 0.024], inner: [0.55, 1, 0.8], outer: [0.62, 0.5, 1] },
  mono: { bg: [0.012, 0.012, 0.012], inner: [0.92, 0.92, 0.92], outer: [0.62, 0.62, 0.62] },
};

const fromHex = (hex: string | undefined): Rgb | null => (hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb : null);

export const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/** Colours chosen by hand, by project key: what a palette takes on top of its own slots. */
export const chosenColors = (projects: { key: string; color: string | null }[] | undefined): Record<string, string> =>
  Object.fromEntries((projects ?? []).flatMap((p) => (p.color ? [[p.key, p.color]] : [])));

export const SWATCHES = SLOT_COLORS.map(toHex);

export function skyColors(o: Pick<UniverseOptions, 'theme' | 'colors'>): SkyColors {
  const base = THEMES[o.theme];
  return { bg: fromHex(o.colors.bg) ?? base.bg, inner: fromHex(o.colors.inner) ?? base.inner, outer: fromHex(o.colors.outer) ?? base.outer };
}
