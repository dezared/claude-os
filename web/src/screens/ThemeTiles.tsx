import { Check } from 'lucide-react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { accentTokens, useAccent } from '@/lib/accent';
import { setTheme, useTheme, type Theme, type ThemeChoice } from '@/lib/theme';

type Look = { bg: string; panel: string; line: string; raised: string; text: string; dim: string; accent: string };

// A picture of each theme whatever theme is on, so its colours are fixed here: the values of the tokens in styles.css.
const LOOKS: Record<Theme, Look> = {
  dark: { bg: '#09090b', panel: '#141418', line: 'rgba(255,255,255,.1)', raised: 'rgba(255,255,255,.08)', text: '#fafafa', dim: '#8b8b95', accent: '#d97757' },
  light: { bg: '#f4f3f1', panel: '#ffffff', line: 'rgba(24,24,27,.12)', raised: 'rgba(24,24,27,.06)', text: '#18181b', dim: '#74747d', accent: '#c2603b' },
};

/** A small window of the app: title bar with tabs, a side list, a chat with a reply, the composer and its button. */
function Picture({ look: l }: { look: Look }) {
  return (
    <>
      <rect width="160" height="96" fill={l.bg} />
      <rect width="160" height="12" fill={l.panel} />
      <circle cx="7" cy="6" r="2.2" fill={l.accent} />
      <rect x="14" y="3.5" width="22" height="5" rx="2" fill={l.raised} />
      <rect x="40" y="4.5" width="16" height="3" rx="1.5" fill={l.dim} opacity=".6" />
      <rect y="12" width="160" height=".6" fill={l.line} />
      <rect x="0" y="12.6" width="38" height="83.4" fill={l.panel} />
      <rect x="38" y="12.6" width=".6" height="83.4" fill={l.line} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x="6" y={20 + i * 10} width="4" height="4" rx="1" fill={i === 0 ? l.accent : l.dim} opacity={i === 0 ? 1 : 0.5} />
          <rect x="13" y={21 + i * 10} width={i === 0 ? 19 : 15 - i} height="2.4" rx="1.2" fill={i === 0 ? l.text : l.dim} opacity={i === 0 ? 0.85 : 0.6} />
        </g>
      ))}
      <rect x="46" y="20" width="62" height="2.6" rx="1.3" fill={l.text} opacity=".8" />
      <rect x="46" y="26" width="84" height="2.6" rx="1.3" fill={l.dim} opacity=".7" />
      <rect x="46" y="32" width="70" height="2.6" rx="1.3" fill={l.dim} opacity=".7" />
      <rect x="104" y="42" width="48" height="11" rx="4" fill={l.raised} />
      <rect x="109" y="46.3" width="34" height="2.4" rx="1.2" fill={l.text} opacity=".7" />
      <rect x="46" y="60" width="56" height="2.6" rx="1.3" fill={l.dim} opacity=".7" />
      <rect x="44" y="76" width="110" height="14" rx="5" fill={l.panel} stroke={l.line} strokeWidth=".6" />
      <rect x="49" y="81.8" width="44" height="2.4" rx="1.2" fill={l.dim} opacity=".6" />
      <rect x="136" y="79" width="14" height="8" rx="3" fill={l.accent} />
    </>
  );
}

// Auto shows both: the light window cut along the diagonal over the dark one, like the system's own tile.
function Preview({ choice, looks }: { choice: ThemeChoice; looks: Record<Theme, Look> }) {
  return (
    <svg viewBox="0 0 160 96" aria-hidden="true" className="block w-full">
      <defs>
        <clipPath id="theme-auto-half"><path d="M0 0H160L0 96Z" /></clipPath>
      </defs>
      <Picture look={looks[choice === 'light' ? 'light' : 'dark']} />
      {choice === 'system' && <g clipPath="url(#theme-auto-half)"><Picture look={looks.light} /></g>}
    </svg>
  );
}

const TILE = 'press group relative block cursor-pointer overflow-hidden rounded-[10px] text-left outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[10px] after:transition-shadow after:duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent';
const ON = 'after:shadow-[inset_0_0_0_1.5px_var(--color-accent)]';
const OFF = 'after:shadow-[inset_0_0_0_1px_var(--color-line)] hover:after:shadow-[inset_0_0_0_1px_var(--color-dim)]';

/** The interface theme as pictures, like the sky below it: each tile shows its own theme whichever one is on. */
const CHOICES: ThemeChoice[] = ['light', 'dark', 'system'];

/** The pictures in the picked accent, so a change of colour shows on them at once. */
function useLooks(): Record<Theme, Look> {
  const pick = useAccent((s) => s.pick);
  if (!pick) return LOOKS;
  const tokens = accentTokens(pick);
  return { dark: { ...LOOKS.dark, accent: tokens.dark.accent }, light: { ...LOOKS.light, accent: tokens.light.accent } };
}

export function ThemeTiles() {
  const current = useTheme((s) => s.choice);
  const looks = useLooks();
  return (
    <div role="radiogroup" aria-label={t('settings.theme')} className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 py-3">
      {CHOICES.map((theme) => {
        const on = theme === current;
        const look = looks[theme === 'light' ? 'light' : 'dark'];
        return (
          <label key={theme} className={cn(TILE, on ? ON : OFF)}>
            <input type="radio" name="ui-theme" className="sr-only" checked={on} onChange={() => setTheme(theme)} />
            <Preview choice={theme} looks={looks} />
            <span className="flex items-center justify-between gap-1 px-2.5 py-1.5 text-[12px]" style={{ background: look.panel, color: on ? look.text : look.dim, boxShadow: `inset 0 1px 0 ${look.line}` }}>
              <span className="truncate">{t(`settings.theme.${theme}`)}</span>
              {on && <Check size={12} className="flex-none" style={{ color: look.accent }} />}
            </span>
          </label>
        );
      })}
    </div>
  );
}
