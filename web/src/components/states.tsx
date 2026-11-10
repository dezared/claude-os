import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Button } from './ui';
import { t } from '@/lib/i18n';

export function Empty({ children, className, icon: Icon }: { children: ReactNode; className?: string; icon?: LucideIcon }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-lg bg-white/[.035] px-3 py-2.5 text-xs text-muted', className)}>
      {Icon && <Icon size={14} className="mt-px flex-none text-dim" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Skeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label={t('common.loading')} className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${88 - ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} aria-hidden className={cn('spinner text-dim', className)} />;
}

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-lg border border-line bg-white/[.03] p-3 text-xs text-soft', className)}>
      <AlertTriangle size={14} className="mt-px flex-none text-accent" />
      <div className="min-w-0 flex-1">
        <div className="overflow-wrap-anywhere">{message}</div>
        {onRetry && (
          <Button size="sm" className="mt-2" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Standard data boundary: first load, error with no data, empty, or content. A refetch error keeps old data. */
export function Boundary<T>({
  query,
  empty,
  skeleton,
  errorClassName,
  children,
}: {
  query: { data: T | undefined; error: string | null; loading: boolean; refetch: () => void };
  empty?: (data: T) => ReactNode | null;
  skeleton?: ReactNode;
  errorClassName?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.data === undefined || query.data === null) {
    if (query.error) return <ErrorState className={errorClassName} message={query.error} onRetry={query.refetch} />;
    return <>{skeleton ?? <Skeleton />}</>;
  }
  const e = empty?.(query.data);
  if (e) return <>{e}</>;
  return <>{children(query.data)}</>;
}
