import type { CSSProperties } from 'react';
import { ACCENTS, setAccent, useAccent } from '@/lib/accent';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { Row } from './SettingsRows';

// A round swatch; the ring around the picked one grows in, the dot itself gives way a little, as in the system settings.
const DOT = 'press relative grid size-[22px] cursor-pointer place-items-center rounded-full transition-[box-shadow,transform] duration-150 ease-[var(--ease-ui)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent';
const RING = 'shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_var(--swatch)] scale-[.9]';
const IDLE = 'shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)] hover:scale-[1.08]';
const RAINBOW = 'conic-gradient(from 180deg, #ff453a, #f5c518, #30c15a, #0a84ff, #a35ee8, #f0507e, #ff453a)';

/** The accent colour: the shipped one, a few system hues and any colour of the person's own. */
export function AccentSwatches() {
  const pick = useAccent((s) => s.pick);
  const own = pick !== null && !ACCENTS.some((a) => a.hex === pick);
  return (
    <Row label={t('set.accent')} hint={t('set.accentHint')}>
      <div role="radiogroup" aria-label={t('set.accent')} className="flex flex-wrap items-center gap-2.5">
        {ACCENTS.map((a) => {
          const on = (pick ?? ACCENTS[0].hex) === a.hex;
          return (
            <label key={a.id} title={t(`set.accent.${a.id}`)} className={cn(DOT, on ? RING : IDLE)} style={{ background: a.hex, '--swatch': a.hex } as CSSProperties}>
              <input type="radio" name="ui-accent" className="sr-only" aria-label={t(`set.accent.${a.id}`)} checked={on} onChange={() => setAccent(a.hex)} />
            </label>
          );
        })}
        <label title={t('set.accentOwn')} className={cn(DOT, own ? RING : IDLE)} style={{ background: RAINBOW, '--swatch': own ? pick : 'var(--color-line)' } as CSSProperties}>
          <input type="color" className="sr-only" aria-label={t('set.accentOwn')} value={pick ?? ACCENTS[0].hex} onChange={(e) => setAccent(e.target.value)} />
          <span aria-hidden className={cn('size-2.5 rounded-full shadow-[0_0_0_1.5px_#fff] transition-transform duration-150 ease-[var(--ease-ui)]', own ? 'scale-100' : 'scale-0')} style={{ background: pick ?? undefined }} />
        </label>
      </div>
    </Row>
  );
}
