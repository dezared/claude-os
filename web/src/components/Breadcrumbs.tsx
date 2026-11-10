import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useApp, type View } from '@/lib/store';

export interface Crumb {
  label: string;
  view?: View; // none: the current place, or a level with no screen of its own
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const go = useApp((s) => s.go);
  return (
    <nav aria-label={t('crumbs.aria')} className={cn('flex min-w-0 flex-wrap items-center gap-1 text-xs text-dim', className)}>
      {items.map((c, i) => (
        <Fragment key={`${i}${c.label}`}>
          {i > 0 && <ChevronRight size={11} className="flex-none" />}
          {c.view ? (
            <button type="button" onClick={() => go(c.view!)} className="press max-w-64 truncate rounded px-1 text-muted hover:text-fg">{c.label}</button>
          ) : (
            <span aria-current={i === items.length - 1 ? 'page' : undefined} className={cn('max-w-64 truncate px-1', i === items.length - 1 && 'text-soft')}>{c.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
