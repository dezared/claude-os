import * as Popover from '@radix-ui/react-popover';
import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface MenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Starts a group of its own, set apart by a line. */
  apart?: boolean;
}

/** One item of a menu: shared with the right-click menu, which highlights without moving focus. */
export function MenuRow({ item, onChoose, id, active, onHover }: { item: MenuItem; onChoose: () => void; id?: string; active?: boolean; onHover?: () => void }) {
  return (
    <div role="none">
      {item.apart && <div role="separator" className="mx-1.5 my-1 border-t border-line2" />}
      <button
        id={id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={item.disabled}
        title={item.title}
        onClick={onChoose}
        onPointerEnter={onHover}
        className={cn(
          'press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none disabled:opacity-40',
          item.danger ? 'text-[#f0a58c] enabled:hover:bg-accent-bg enabled:focus-visible:bg-accent-bg' : 'text-soft enabled:hover:bg-raised enabled:hover:text-fg enabled:focus-visible:bg-raised enabled:focus-visible:text-fg',
          active && (item.danger ? 'bg-accent-bg' : 'bg-raised text-fg'),
        )}
      >
        <item.icon size={13} className={cn('flex-none', item.danger ? 'text-accent' : 'text-dim')} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
    </div>
  );
}

/**
 * A menu in the WAI-ARIA sense over a Radix popover: focus moves in on open and returns to the trigger on close,
 * arrows, Home, End and first letters move between items, Enter and Space choose, Escape and Tab close.
 */
export function ActionMenu({
  trigger,
  label,
  items,
  open,
  onOpenChange,
  side = 'right',
  align = 'start',
}: {
  trigger: ReactNode;
  label: string;
  items: MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'right' | 'bottom';
  align?: 'start' | 'end';
}) {
  const list = useRef<HTMLDivElement>(null);

  const onKey = (e: KeyboardEvent) => {
    // Portals bubble through the React tree: the keys of the menu are not the business of whatever opened it.
    e.stopPropagation();
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      onOpenChange(false);
    } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = e.key.toLowerCase();
      const next = [...all.slice(at + 1), ...all.slice(0, at + 1)].find((b) => b.textContent?.trim().toLowerCase().startsWith(letter));
      next?.focus();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={list}
          role="menu"
          aria-label={label}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          onKeyDown={onKey}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
          }}
          className="enter-pop popover z-50 w-72 rounded-xl p-1 outline-none"
        >
          {items.map((item) => (
            <MenuRow
              key={item.id}
              item={item}
              onChoose={() => {
                onOpenChange(false);
                item.onSelect();
              }}
            />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
