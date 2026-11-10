import { ClipboardPaste, Copy, MessageCircleQuestionMark, Pencil, Scissors } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MenuRow, type MenuItem } from '@/home/ActionMenu';
import { t } from '@/lib/i18n';
import { askClaude, type AskSubject } from '@/lib/microtask';
import { toastError } from '@/lib/store';

export type ContextItems = MenuItem[] | ((e: MouseEvent) => MenuItem[] | null | undefined);

const EDGE = 8;
const DRAG_SLOP = 4;
const TEXT_FIELD = 'textarea, input:not([type=checkbox],[type=radio],[type=file],[type=button],[type=submit],[type=range],[type=color]), [contenteditable=""], [contenteditable="true"]';

// Found by walking up from the target, so a portal's content never picks up the items of whatever opened it.
const areas = new WeakMap<Element, Set<RefObject<ContextItems>>>();

/** Adds items to the menu of an element that is not rendered by the caller. Returns the cleanup. */
export function registerContextArea(el: Element, items: RefObject<ContextItems>) {
  const set = areas.get(el) ?? new Set();
  areas.set(el, set);
  set.add(items);
  return () => void set.delete(items);
}

/** `<div ref={useContextMenu(items)}>`: right click inside the element adds these items to the menu. */
export function useContextMenu(items: ContextItems): RefCallback<Element> {
  const latest = useRef(items);
  latest.current = items;
  return useCallback((el: Element | null) => (el ? registerContextArea(el, latest) : undefined), []);
}

/** The same as a wrapper. Without a className it adds no box to the layout. */
export function ContextArea({ items, className = 'contents', children }: { items: ContextItems; className?: string; children: ReactNode }) {
  return <div ref={useContextMenu(items)} className={className}>{children}</div>;
}

/** claude.change and claude.ask for one subject. The innermost subject wins over the areas around it. */
export function claudeItems(subject: AskSubject, opts: { changePresets?: string[]; askPresets?: string[] } = {}): MenuItem[] {
  const { name } = subject;
  const askPresets = opts.askPresets ?? [t('ask.presetWhat'), t('ask.presetProblems')];
  return [
    { id: 'claude.change', label: t('claude.change'), icon: Pencil, onSelect: () => askClaude({ subject, intent: 'change', title: t('claude.changeTitle', { name }), presets: opts.changePresets, placeholder: t('ask.changePlaceholder') }) },
    { id: 'claude.ask', label: t('claude.ask'), icon: MessageCircleQuestionMark, onSelect: () => askClaude({ subject, title: t('claude.askTitle', { name }), presets: askPresets }) },
  ];
}

function askSelection(text: string): MenuItem {
  const clean = text.trim();
  const name = clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
  return {
    id: 'text.ask',
    label: t('menu.askSelected'),
    icon: MessageCircleQuestionMark,
    onSelect: () => askClaude({ subject: { kind: 'selected text', name, context: clean }, title: t('menu.askSelected') }),
  };
}

function fieldItems(field: HTMLElement): MenuItem[] {
  const plain = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
  const secret = field instanceof HTMLInputElement && field.type === 'password';
  const locked = !!plain && (plain.readOnly || plain.disabled);
  const selected = secret ? '' : plain ? plain.value.slice(plain.selectionStart ?? 0, plain.selectionEnd ?? 0) : (getSelection()?.toString() ?? '');
  const run = (command: 'cut' | 'copy') => () => {
    field.focus();
    document.execCommand(command);
  };
  return [
    { id: 'text.cut', label: t('menu.cut'), icon: Scissors, disabled: locked || !selected, onSelect: run('cut') },
    { id: 'text.copy', label: t('menu.copy'), icon: Copy, disabled: !selected, onSelect: run('copy') },
    {
      id: 'text.paste',
      label: t('menu.paste'),
      icon: ClipboardPaste,
      disabled: locked,
      onSelect: () => {
        field.focus();
        navigator.clipboard.readText().then((text) => {
          // The field's own paste handling goes first, as with Ctrl+V: the chat input folds a long text.
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', text);
          if (!field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))) return;
          // insertText goes through the field's own input event: React state and undo both see it.
          document.execCommand('insertText', false, text);
        }).catch(toastError);
      },
    },
    ...(selected.trim() ? [askSelection(selected)] : []),
  ];
}

function selectionItems(e: MouseEvent): MenuItem[] {
  const sel = getSelection();
  const text = sel?.toString() ?? '';
  if (!sel || !text.trim() || sel.rangeCount === 0) return [];
  const over = [...sel.getRangeAt(0).getClientRects()].some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
  if (!over) return [];
  return [{ id: 'text.copy', label: t('menu.copy'), icon: Copy, onSelect: () => void document.execCommand('copy') }, askSelection(text)];
}

function collect(e: MouseEvent, target: Element): MenuItem[][] {
  const field = target.closest<HTMLElement>(TEXT_FIELD);
  const groups = [field ? fieldItems(field) : selectionItems(e)];
  for (let el: Element | null = target; el; el = el.parentElement) {
    for (const area of areas.get(el) ?? []) {
      const items = area.current;
      groups.push((typeof items === 'function' ? items(e) : items) ?? []);
    }
  }
  return groups;
}

/** Groups in order, innermost first: the first item with an id wins, and each group after the first gets a line. */
function flatten(groups: MenuItem[][]): MenuItem[] {
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const group of groups) {
    const fresh = group.filter((i) => !seen.has(i.id) && seen.add(i.id));
    fresh.forEach((item, i) => out.push({ ...item, apart: out.length > 0 && (i === 0 || item.apart) }));
  }
  return out;
}

type Open = { x: number; y: number; items: MenuItem[]; anchor?: Element; at?: DOMRect };

let show: ((menu: Open | null) => void) | null = null;

/** For surfaces that decide on their own when a right click is a click, like the universe stage. */
export function openContextMenu(x: number, y: number, groups: MenuItem[][], anchor?: Element) {
  const items = flatten(groups);
  show?.(items.length ? { x, y, items, anchor, at: anchor?.getBoundingClientRect() } : null);
}

/** What was clicked has left the place the menu points at. A scroll elsewhere, or one that ended before the click and is reported a frame later, moves nothing. */
function anchorMoved({ anchor, at }: Open) {
  if (!anchor?.isConnected || !at) return true;
  const now = anchor.getBoundingClientRect();
  return Math.abs(now.left - at.left) > 1 || Math.abs(now.top - at.top) > 1;
}

/** Mounted once. Focus stays where it is, so a text field keeps its selection and a modal keeps its focus trap. */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<Open | null>(null);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    show = (next) => {
      setActive(-1);
      setMenu(next);
    };
    let press: { x: number; y: number } | null = null;
    const onPress = (e: PointerEvent) => {
      if (e.button === 2) press = { x: e.clientX, y: e.clientY };
      if (!(e.target instanceof Node && box.current?.contains(e.target))) setMenu(null);
    };
    const onContext = (e: MouseEvent) => {
      const from = press;
      press = null;
      // Whoever prevented it has a menu of its own.
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      if (!target || box.current?.contains(target)) return;
      // Windows sends this on release: the end of a right drag is not a click.
      if (from && e.button === 2 && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP) return;
      openContextMenu(e.clientX, e.clientY, collect(e, target), target);
    };
    window.addEventListener('pointerdown', onPress, true);
    document.addEventListener('contextmenu', onContext);
    return () => {
      show = null;
      window.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('contextmenu', onContext);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return close();
      // Before Radix and the universe: Escape closes only this, letters do not reach a field or the camera.
      e.stopPropagation();
      e.preventDefault();
      const enabled = menu.items.flatMap((item, i) => (item.disabled ? [] : [i]));
      const at = enabled.indexOf(active);
      const move = (i: number) => setActive(enabled[(i + enabled.length) % enabled.length] ?? -1);
      if (e.key === 'ArrowDown') move(at + 1);
      else if (e.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
      else if (e.key === 'Home') move(0);
      else if (e.key === 'End') move(-1);
      else if (e.key === 'Escape' || e.key === 'Tab') close();
      else if (e.key === 'Enter' || e.key === ' ') {
        close();
        if (active >= 0) menu.items[active].onSelect();
      } else if (e.key.length === 1) {
        const letter = e.key.toLowerCase();
        const next = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)].find((i) => menu.items[i].label.toLowerCase().startsWith(letter));
        if (next !== undefined) setActive(next);
      }
    };
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target)) && anchorMoved(menu)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu, active]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !menu) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const flipX = menu.x + w > window.innerWidth - EDGE;
    const flipY = menu.y + h > window.innerHeight - EDGE;
    el.style.left = `${flipX ? Math.max(EDGE, menu.x - w) : menu.x}px`;
    el.style.top = `${flipY ? Math.max(EDGE, menu.y - h) : menu.y}px`;
    // It grows out of the point that was clicked.
    el.style.transformOrigin = `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`;
    // A modal treats anything outside it as a click away: this press stays here. The capture listener above still sees it.
    const keep = (e: PointerEvent) => e.stopPropagation();
    el.addEventListener('pointerdown', keep);
    return () => el.removeEventListener('pointerdown', keep);
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={t('menu.aria')}
      aria-activedescendant={active >= 0 ? `ctx-${active}` : undefined}
      data-context-menu
      style={{ left: menu.x, top: menu.y, maxHeight: `calc(100vh - ${EDGE * 2}px)`, pointerEvents: 'auto' }}
      onMouseDown={(e) => e.preventDefault()}
      className="enter-pop popover fixed z-[60] w-72 overflow-auto rounded-xl p-1 outline-none"
    >
      {menu.items.map((item, i) => (
        <MenuRow
          key={item.id}
          id={`ctx-${i}`}
          item={item}
          active={i === active}
          onHover={() => setActive(item.disabled ? -1 : i)}
          onChoose={() => {
            setMenu(null);
            item.onSelect();
          }}
        />
      ))}
    </div>,
    document.body,
  );
}
