import { cn, statusLabel } from '@/lib/format';
import type { SessionStatus } from '@/lib/types';
import { t } from '@/lib/i18n';

/** Accent means "needs eyes or is doing something". Attention is a solid ring, working is a pulse. */
export function StatusDot({ status, attention, className }: { status: SessionStatus; attention?: boolean; className?: string }) {
  const needsYou = attention || status === 'waiting_permission' || status === 'blocked';
  return (
    <span
      role="img"
      aria-label={needsYou ? t('dot.needsYou', { status: statusLabel(status) }) : statusLabel(status)}
      className={cn(
        'block size-1.5 flex-none rounded-full',
        needsYou && 'bg-accent shadow-[0_0_0_3px_rgba(217,119,87,.28)]',
        !needsYou && status === 'working' && 'dot-working bg-accent',
        !needsYou && status === 'idle' && 'bg-accent/60',
        !needsYou && status === 'ended' && 'bg-white/25',
        className,
      )}
    />
  );
}
