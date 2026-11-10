import { Check } from 'lucide-react';
import { cn } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import type { UniverseOptions, UniverseTheme } from '@/lib/types';
import { THEMES, toHex, type SkyColors } from './colors';
import { setUniverse } from './menu';

const THEME_LABELS: [UniverseTheme, Key][] = [
  ['default', 'universe.themeDefault'],
  ['ember', 'universe.themeEmber'],
  ['aurora', 'universe.themeAurora'],
  ['mono', 'universe.themeMono'],
];

// The same picture for every theme: four arms winding out of a bright middle, seen at the map's tilt.
const DOTS = Array.from({ length: 96 }, (_, i) => {
  const u = ((i * 0.618034) % 1) ** 0.75;
  const angle = (i % 4) * (Math.PI / 2) + u * 4.4 + Math.sin(i * 12.9898) * 0.28;
  const d = 3 + u * 40;
  return { x: 48 + Math.cos(angle) * d, y: 30 + Math.sin(angle) * d * 0.56, r: 0.32 + ((i * 0.381966) % 1) * 0.42, u };
});

const mix = (sky: SkyColors, u: number) => toHex([0, 1, 2].map((c) => sky.inner[c] * (1 - u) + sky.outer[c] * u) as SkyColors['bg']);

function SkyPreview({ sky, id }: { sky: SkyColors; id: string }) {
  return (
    <svg viewBox="0 0 96 60" aria-hidden="true" className="block w-full" style={{ background: toHex(sky.bg) }}>
      <defs>
        <radialGradient id={id}>
          <stop offset="0" stopColor={toHex(sky.inner)} stopOpacity=".62" />
          <stop offset=".35" stopColor={mix(sky, 0.25)} stopOpacity=".2" />
          <stop offset="1" stopColor={toHex(sky.outer)} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="48" cy="30" rx="44" ry="25" fill={`url(#${id})`} />
      {DOTS.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={mix(sky, d.u)} opacity={0.95 - d.u * 0.45} />)}
      <circle cx="48" cy="30" r="1.5" fill="#fff" opacity=".95" />
    </svg>
  );
}

const TILE = 'press group relative block cursor-pointer overflow-hidden rounded-[10px] text-left outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[10px] after:transition-shadow after:duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const ON = 'after:shadow-[inset_0_0_0_1.5px_var(--color-accent)]';
const OFF = 'after:shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)] hover:after:shadow-[inset_0_0_0_1px_rgba(255,255,255,.22)]';

function Caption({ on, children }: { on: boolean; children: string }) {
  return (
    <span className={cn('flex items-center justify-between gap-1 bg-black/45 px-2 py-1 text-[11.5px] transition-colors duration-150', on ? 'text-fg' : 'text-muted group-hover:text-fg')}>
      <span className="truncate">{children}</span>
      {on && <Check size={11} className="flex-none text-accent" />}
    </span>
  );
}

/** The sky at a glance. A theme is what it shows: picking one drops colours set in the config file, which would otherwise stay on top of it. */
export function SkyThemes({ options }: { options: UniverseOptions }) {
  const own = Object.keys(options.colors).length > 0;
  return (
    <div role="radiogroup" aria-label={t('set.skyTheme')} className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5 py-3">
      {THEME_LABELS.map(([theme, label]) => {
        const on = !own && options.theme === theme;
        return (
          <label key={theme} className={cn(TILE, on ? ON : OFF)}>
            <input type="radio" name="sky-theme" className="sr-only" checked={on} onChange={() => void setUniverse(own ? { theme, colors: {} } : { theme })} />
            <SkyPreview sky={THEMES[theme]} id={`sky-${theme}`} />
            <Caption on={on}>{t(label)}</Caption>
          </label>
        );
      })}
    </div>
  );
}
