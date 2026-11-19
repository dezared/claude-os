import { X } from 'lucide-react';
import { useRef } from 'react';
import { useFlip } from '@/lib/flip';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/format';
import { IconButton } from './ui';
import { t } from '@/lib/i18n';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const box = useRef<HTMLDivElement>(null);
  useFlip(box); // one leaves: it fades where it was and the others slide down into its place
  return (
    <div ref={box} aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-70 flex w-90 flex-col gap-2">
      {toasts.map((item) => (
        <div key={item.id} data-flip={item.id} role={item.kind === 'error' ? 'alert' : 'status'} className={cn('enter-fade pointer-events-auto flex items-start gap-2 rounded-xl border bg-panel py-2 pr-1.5 pl-3 shadow-xl', item.kind === 'error' ? 'border-accent-deep' : 'border-line')}>
          <div className="selectable min-w-0 flex-1 pt-0.5 wrap-anywhere text-soft">{item.text}</div>
          {item.action && <button type="button" onClick={item.action.onClick} className="press flex-none rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg">{item.action.label}</button>}
          <IconButton label={t('common.hide')} className="size-6" onClick={() => dismiss(item.id)}>
            <X size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
