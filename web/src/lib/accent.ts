import { create } from 'zustand';

/** The accent colours offered as swatches; `claude` is the shipped accent and keeps the tuned tokens of styles.css. */
export const ACCENTS = [
  { id: 'claude', hex: '#d97757' },
  { id: 'blue', hex: '#0a84ff' },
  { id: 'purple', hex: '#a35ee8' },
  { id: 'pink', hex: '#f0507e' },
  { id: 'red', hex: '#ff453a' },
  { id: 'yellow', hex: '#f5c518' },
  { id: 'green', hex: '#30c15a' },
  { id: 'graphite', hex: '#8e8e93' },
] as const;
export type AccentId = (typeof ACCENTS)[number]['id'];

// Kept by the browser like the theme: a look of this window's profile, not a server setting.
const STORAGE_KEY = 'claude-os.accent';
const HEX = /^#[0-9a-f]{6}$/;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, k: number) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * k) as Rgb);
const alpha = (c: string, a: number) => `rgba(${rgb(c).join(', ')}, ${a})`;

function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The accent is also text (links, active marks): it moves toward white or black until it reads on the theme's surfaces.
function fit(pick: string, surface: string, toward: string): string {
  let c = pick;
  for (let k = 0.05; contrast(c, surface) < 4.5 && k <= 1; k += 0.05) c = mix(pick, toward, k);
  return c;
}

const ON_DARK = '#1a0d07';
const onAccent = (c: string) => (contrast(c, '#ffffff') >= contrast(c, ON_DARK) ? '#ffffff' : ON_DARK);

/** The accent tokens one picked colour gives each theme: the same names styles.css tunes by hand for the shipped accent. */
export function accentTokens(pick: string) {
  const dark = fit(pick, '#141418', '#ffffff');
  const light = fit(pick, '#ffffff', '#000000');
  return {
    dark: { accent: dark, hover: mix(dark, '#ffffff', 0.15), deep: mix(dark, '#000000', 0.2), bg: alpha(dark, 0.12), on: onAccent(dark) },
    light: { accent: light, hover: mix(light, '#000000', 0.14), deep: mix(light, '#000000', 0.3), bg: alpha(light, 0.12), on: onAccent(light) },
  };
}

function stored(): string | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v && HEX.test(v) ? v : null;
}

// Custom properties on <html> that the [data-accent] rules of styles.css read; no attribute means the shipped accent.
function apply(pick: string | null) {
  const root = document.documentElement;
  if (pick === null) delete root.dataset.accent;
  else {
    root.dataset.accent = '';
    const tokens = accentTokens(pick);
    for (const [theme, set] of Object.entries(tokens)) {
      for (const [name, value] of Object.entries(set)) root.style.setProperty(`--pick-${theme}-${name}`, value);
    }
    root.style.setProperty('--pick-sky-bg', alpha(tokens.dark.accent, 0.18));
  }
  useAccent.setState({ pick });
}

/** The picked accent, a #rrggbb colour, or null for the shipped one. */
export const useAccent = create<{ pick: string | null }>(() => ({ pick: null }));
apply(stored());

export function setAccent(pick: string | null) {
  const value = pick === ACCENTS[0].hex ? null : pick;
  if (value === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, value);
  apply(value);
}

// A popout window shares the storage: it follows a change made in the main window.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) apply(stored());
});
