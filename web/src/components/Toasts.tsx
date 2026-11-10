import { X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/format';
import { IconButton } from './ui';
import { t } from '@/lib/i18n';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-70 flex w-90 flex-col gap-2">
      {toasts.map((item) => (
        <div key={item.id} role={item.kind === 'error' ? 'alert' : 'status'} className={cn('enter-fade pointer-events-auto flex items-start gap-2 rounded-xl border bg-[#141418] py-2 pr-1.5 pl-3 shadow-xl', item.kind === 'error' ? 'border-accent-deep' : 'border-line')}>
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
