import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, X, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'outline' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'outline', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'press inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap disabled:opacity-40',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1',
        variant === 'outline' && 'border border-line bg-white/[.03] text-soft enabled:hover:border-white/20 enabled:hover:bg-white/[.07] enabled:hover:text-fg',
        variant === 'primary' && 'bg-accent font-medium text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,.22)] enabled:hover:bg-accent-hover disabled:bg-white/10 disabled:text-muted disabled:opacity-100 disabled:shadow-none',
        variant === 'danger' && 'bg-[#c2410c] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.2)] enabled:hover:bg-[#d4500f] disabled:bg-white/10 disabled:text-muted disabled:opacity-100 disabled:shadow-none',
        variant === 'ghost' && 'text-muted enabled:hover:bg-raised enabled:hover:text-fg',
        className,
      )}
      {...rest}
    />
  );
}

export function IconButton({ className, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('press inline-flex size-7 flex-none items-center justify-center rounded-md text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-40', className)}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-line bg-white/[.04] px-2.5 py-1.5 text-fg outline-none transition-colors duration-150 placeholder:text-dim hover:border-white/20 focus:border-accent-deep focus:bg-white/[.06]',
        className,
      )}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-md border border-line bg-white/[.04] px-2.5 py-2 text-fg outline-none transition-colors duration-150 placeholder:text-dim hover:border-white/20 focus:border-accent-deep focus:bg-white/[.06]',
        className,
      )}
      {...rest}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </label>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 480,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* The same layer as popovers, so the one opened last is on top; a popover left open dims with the rest. */}
        <DialogPrimitive.Overlay data-covers-map className="no-drag enter-overlay fixed inset-0 z-50 bg-black/55" />
        <DialogPrimitive.Content
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
          className="popover enter-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-96px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl outline-none"
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line2 px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-medium">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-0.5 text-xs text-dim">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label={t('common.close')} className="-mt-1 -mr-1">
                <X size={14} />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 overflow-auto p-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const NONE = '__none__';

export interface SelectOption {
  value: string | null;
  label: string;
  icon?: LucideIcon;
  iconClass?: string;
  content?: ReactNode; // drawn instead of the label, here and in the closed select; the label stays for typing to find
}

function SelectRow({ o }: { o: SelectOption }) {
  return (
    <SelectPrimitive.Item
      value={o.value ?? NONE}
      textValue={o.label}
      className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-muted outline-none data-highlighted:bg-raised data-highlighted:text-fg"
    >
      <SelectPrimitive.ItemText>
        {o.content ?? (o.icon ? (
          <span className="inline-flex items-center gap-1.5">
            <o.icon size={12} className={cn('flex-none', o.iconClass)} />
            {o.label}
          </span>
        ) : o.label)}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check size={12} className="text-accent" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

/** Radix Select, with `null` as a real option value. `groups` come after `options`, each under its header. */
export function Select({
  value,
  onChange,
  options,
  groups,
  ariaLabel,
  className,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  options: SelectOption[];
  groups?: { label: string; options: SelectOption[] }[];
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'press inline-flex min-w-0 items-center justify-between gap-1.5 rounded-md border border-line bg-white/[.03] px-2 py-1 text-soft outline-none hover:border-white/20 hover:bg-white/[.07] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40',
          className,
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown size={12} className="text-dim" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="popover enter-pop z-60 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-xl">
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => <SelectRow key={o.value ?? NONE} o={o} />)}
            {groups?.map((g) => (
              <SelectPrimitive.Group key={g.label}>
                <SelectPrimitive.Label className="px-2 pt-2 pb-0.5 text-[10.5px] text-dim">{g.label}</SelectPrimitive.Label>
                {g.options.map((o) => <SelectRow key={o.value ?? NONE} o={o} />)}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2 select-none">
      <input type="checkbox" className="mt-0.5 size-3.5 flex-none accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-muted">{children}</span>
    </label>
  );
}

export function SectionTitle({ children, aside, icon: Icon }: { children: ReactNode; aside?: ReactNode; icon?: LucideIcon }) {
  return (
    <h3 className="mb-2 flex items-baseline justify-between gap-2 text-[11.5px] font-medium text-muted">
      <span className="flex items-center gap-1.5">
        {Icon && <Icon size={12} className="translate-y-px text-dim" />}
        {children}
      </span>
      {aside != null && <span className="font-normal text-dim">{aside}</span>}
    </h3>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: LucideIcon }[];
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-lg border border-line bg-white/[.03] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('press inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs', value === o.value ? 'bg-white/[.13] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.08)]' : 'text-muted hover:text-fg')}
        >
          {o.icon && <o.icon size={12} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
