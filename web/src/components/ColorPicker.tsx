import * as Popover from '@radix-ui/react-popover';
import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';

const HEX = /^#[0-9a-f]{6}$/i;
const SWATCH = 'press size-5 rounded-full outline-none transition-[box-shadow,transform] duration-150 hover:scale-110 focus-visible:scale-110';
const RING = 'shadow-[0_0_0_2px_#0e0e12,0_0_0_3.5px_rgba(255,255,255,.75)]'; // the chosen one

interface Hsv { h: number; s: number; v: number } // h 0..360, s and v 0..1

function toHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

function toHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Pressed, it follows the pointer even off the element; let go, the colour is the one chosen.
function track(e: PointerEvent<HTMLElement>, move: (x: number, y: number) => void, done: () => void) {
  const el = e.currentTarget;
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    move(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
  };
  el.setPointerCapture(e.pointerId);
  at(e);
  const onMove = (ev: globalThis.PointerEvent) => at(ev);
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    done();
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

/** A colour: one of the palette, or any by hand. `children` is the anchor; the caller opens it (a dot, a menu item). */
export function ColorPicker({ value, onChange, palette, label, open, onOpenChange, children }: { value: string; onChange: (hex: string) => void; palette: readonly string[]; label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const escaped = useRef(false); // Escape drops what was typed; any other way out keeps it
  const [custom, setCustom] = useState<Hsv | null>(null);
  const latest = useRef<Hsv | null>(null); // what a drag ends on, read outside a state update
  const [typed, setTyped] = useState('');
  const hex = custom ? toHex(custom) : value;
  const openCustom = () => {
    sent.current = null;
    set(HEX.test(value) ? toHsv(value) : { h: 0, s: 1, v: 1 });
  };
  const sent = useRef<string | null>(null); // the field's blur after a drag must not send the same colour again
  const send = (next: string) => {
    if (next === (sent.current ?? value.toLowerCase())) return;
    sent.current = next;
    onChange(next);
  };
  const commit = () => {
    if (latest.current) send(toHex(latest.current));
  };
  const set = (next: Hsv) => {
    latest.current = next;
    setCustom(next);
    setTyped(toHex(next));
  };
  const commitTyped = () => {
    const clean = typed.trim().startsWith('#') ? typed.trim() : `#${typed.trim()}`;
    if (!HEX.test(clean)) return setTyped(hex);
    set(toHsv(clean));
    send(clean.toLowerCase());
  };
  const close = () => {
    onOpenChange(false);
    setCustom(null);
  };
  const isCustom = !palette.some((c) => c.toLowerCase() === value.toLowerCase());
  return (
    <Popover.Root
      open={open}
      onOpenChange={(on) => {
        if (on) return onOpenChange(true);
        // The field's blur does not come when the popover goes away under it.
        if (custom && !escaped.current) commitTyped();
        escaped.current = false;
        close();
      }}
    >
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content role="group" aria-label={label} side="bottom" align="start" sideOffset={6} collisionPadding={10} onEscapeKeyDown={() => { escaped.current = true; }} onCloseAutoFocus={(e) => e.preventDefault()} className="enter-pop popover z-50 flex w-max flex-col gap-2 rounded-xl p-1.5 outline-none">
          <div className="flex gap-1">
            {palette.map((color, i) => (
              <button key={color} type="button" aria-label={t('color.pick', { n: i + 1 })} aria-pressed={value.toLowerCase() === color.toLowerCase()} onClick={() => { onChange(color); close(); }} className={cn(SWATCH, value.toLowerCase() === color.toLowerCase() && RING)} style={{ backgroundColor: color }} />
            ))}
            <button type="button" aria-label={t('color.custom')} aria-expanded={custom !== null} aria-pressed={isCustom} onClick={() => (custom ? setCustom(null) : openCustom())} className={cn(SWATCH, (custom || isCustom) && RING)} style={{ background: 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }} />
          </div>
          {custom && (
            <div className="flex flex-col gap-2 px-0.5 pb-0.5">
              <div
                role="slider"
                aria-label={t('color.shade')}
                aria-valuetext={hex}
                data-color-square
                onPointerDown={(e) => track(e, (x, y) => set({ ...custom, s: x, v: 1 - y }), commit)}
                className="relative h-28 w-full cursor-crosshair touch-none rounded-md"
                style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${custom.h} 100% 50%))` }}
              >
                <span className="pointer-events-none absolute size-3 -translate-x-1/2 translate-y-1/2 rounded-full shadow-[0_0_0_2px_#fff,0_0_0_3px_rgba(0,0,0,.4)]" style={{ left: `${custom.s * 100}%`, bottom: `${custom.v * 100}%`, backgroundColor: hex }} />
              </div>
              <div
                role="slider"
                aria-label={t('color.hue')}
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(custom.h)}
                data-color-hue
                onPointerDown={(e) => track(e, (x) => set({ ...custom, h: x * 360 }), commit)}
                className="relative h-3 w-full cursor-pointer touch-none rounded-full"
                style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
              >
                <span className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_#fff,0_0_0_3px_rgba(0,0,0,.4)]" style={{ left: `${(custom.h / 360) * 100}%`, backgroundColor: `hsl(${custom.h} 100% 50%)` }} />
              </div>
              <input
                aria-label={t('color.hex')}
                value={typed}
                maxLength={7}
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onBlur={commitTyped}
                onKeyDown={(e) => { if (e.key === 'Enter') commitTyped(); }}
                className="w-full rounded-md bg-white/[.08] px-2 py-0.5 font-mono text-xs text-fg outline-none"
              />
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
