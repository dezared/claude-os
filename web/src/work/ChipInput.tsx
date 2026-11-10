import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject, type TextareaHTMLAttributes } from 'react';
import { t } from '@/lib/i18n';
import { pastePattern } from './pastes';

/**
 * Inline objects of the chat input: a piece of the text that stands for something bigger and shows as a chip.
 * The model stays the plain string, the chip is its mark. Mentions or files can become kinds of their own later.
 */
export interface ChipKind {
  kind: string;
  pattern: () => RegExp; // global; the first group that matched is the id
  label: (id: string) => string;
}

export const CHIP_KINDS: ChipKind[] = [{ kind: 'paste', pattern: pastePattern, label: (id) => t('composer.pasteChip', { n: id }) }];

export interface Chip {
  kind: string;
  id: string;
  start: number;
  end: number;
  text: string;
}

export function findChips(value: string): Chip[] {
  return CHIP_KINDS.flatMap((k) => [...value.matchAll(k.pattern())].map((m) => ({ kind: k.kind, id: m.slice(1).find((g) => g !== undefined) ?? '', start: m.index, end: m.index + m[0].length, text: m[0] }))).sort((a, b) => a.start - b.start);
}

const layerOf = (field: HTMLTextAreaElement) => field.parentElement?.querySelector<HTMLElement>(':scope > [data-chip-layer]') ?? null;

/** The chip under a point of the field, read off the chips drawn behind it. */
export function chipAt(field: HTMLTextAreaElement, x: number, y: number): Chip | null {
  const spans = layerOf(field)?.querySelectorAll<HTMLElement>('[data-chip]') ?? [];
  const hit = [...spans].find((s) => [...s.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
  return hit ? findChips(field.value).find((c) => c.start === Number(hit.dataset.start)) ?? null : null;
}

const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordBreak', 'overflowWrap'] as const;

/**
 * A textarea with its chips drawn behind its own text, in the same place: caret, selection, undo, IME, autosize,
 * execCommand and every reader of `.value` stay the textarea's. A chip is deleted as one piece, the caret does not stop inside it.
 */
export function ChipInput({ ref, value, className, onKeyDown, onSelect, onScroll, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref: RefObject<HTMLTextAreaElement | null>; value: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const chips = useMemo(() => findChips(value), [value]);
  const caret = useRef(0);

  // Anchored to the bottom like the field itself: while the compact row animates its height, the two move together.
  const sync = () => {
    const f = ref.current;
    const l = layer.current;
    const parent = f?.offsetParent;
    if (!f || !l || !parent) return;
    const s = getComputedStyle(f);
    for (const p of COPIED) l.style[p] = s[p];
    l.style.left = `${f.offsetLeft}px`;
    l.style.bottom = `${parent.clientHeight - f.offsetTop - f.offsetHeight}px`;
    l.style.width = `${f.clientWidth}px`;
    l.style.height = `${f.clientHeight}px`;
    l.scrollTop = f.scrollTop;
  };
  const latest = useRef(sync);
  latest.current = sync;
  useLayoutEffect(sync);

  const drawn = chips.length > 0;
  useEffect(() => {
    const f = ref.current;
    if (!drawn || !f) return;
    const observer = new ResizeObserver(() => latest.current());
    observer.observe(f);
    return () => observer.disconnect();
  }, [drawn, ref]);

  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const c of chips) {
    if (c.start < at) continue;
    parts.push(value.slice(at, c.start));
    parts.push(<span key={c.start} data-chip={c.kind} data-id={c.id} data-start={c.start} className="rounded-sm bg-accent-bg ring-1 ring-accent-deep/50 box-decoration-clone">{c.text}</span>);
    at = c.end;
  }

  return (
    <>
      {drawn && (
        <div ref={layer} data-chip-layer aria-hidden className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap text-transparent select-none">
          {parts}
          {value.slice(at)}
          {'\u200b' /* a last empty line takes its height, as in the field */}
        </div>
      )}
      <textarea
        {...rest}
        ref={ref}
        value={value}
        className={`relative ${className ?? ''}`}
        onScroll={(e) => {
          if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop;
          onScroll?.(e);
        }}
        onSelect={(e) => {
          const f = e.currentTarget;
          const was = caret.current;
          if (f.selectionStart === f.selectionEnd) {
            const inside = chips.find((c) => f.selectionStart > c.start && f.selectionStart < c.end);
            if (inside) {
              // An arrow step goes on in its direction; a click lands on the nearer edge.
              const p = f.selectionStart;
              const to = Math.abs(p - was) === 1 ? (was > p ? inside.start : inside.end) : p - inside.start < inside.end - p ? inside.start : inside.end;
              f.setSelectionRange(to, to);
            }
          } else {
            // A selection takes a chip whole or not at all: typing over half a mark would leave words that stand for nothing.
            const from = chips.find((c) => f.selectionStart > c.start && f.selectionStart < c.end)?.start ?? f.selectionStart;
            const to = chips.find((c) => f.selectionEnd > c.start && f.selectionEnd < c.end)?.end ?? f.selectionEnd;
            if (from !== f.selectionStart || to !== f.selectionEnd) f.setSelectionRange(from, to, f.selectionDirection);
          }
          caret.current = f.selectionStart;
          onSelect?.(e);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.nativeEvent.isComposing || (e.key !== 'Backspace' && e.key !== 'Delete')) return;
          const f = e.currentTarget;
          if (f.selectionStart !== f.selectionEnd) return;
          const p = f.selectionStart;
          const chip = chips.find((c) => (e.key === 'Backspace' ? c.end === p : c.start === p));
          if (!chip) return;
          e.preventDefault();
          f.setSelectionRange(chip.start, chip.end);
          document.execCommand('delete'); // through the field's own input event: React state and undo both see it
        }}
      />
    </>
  );
}
