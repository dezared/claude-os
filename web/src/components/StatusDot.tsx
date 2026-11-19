import { cn, statusLabel } from '@/lib/format';
import type { SessionStatus } from '@/lib/types';
import { t } from '@/lib/i18n';

// The text colour is the colour of the subagent ripple around the dot.
const TONE: Partial<Record<SessionStatus, string>> = {
  working: 'dot-working bg-accent text-accent',
  idle: 'bg-fg/35 text-fg/55',
  ended: 'bg-fg/25',
};

/** Accent means "needs eyes or is doing something". Attention is a solid ring, working is a pulse, rings rippling out mean subagents at work. */
export function StatusDot({ status, attention, subagents = 0, className }: { status: SessionStatus; attention?: boolean; subagents?: number; className?: string }) {
  const needsYou = attention || status === 'waiting_permission' || status === 'blocked';
  return (
    <span
      role="img"
      aria-label={needsYou ? t('dot.needsYou', { status: statusLabel(status) }) : statusLabel(status)}
      className={cn(
        'status-dot block size-1.5 flex-none rounded-full',
        needsYou ? 'bg-accent shadow-[0_0_0_3px_rgba(217,119,87,.28)]' : TONE[status],
        !needsYou && subagents > 0 && 'dot-agents',
        className,
      )}
    />
  );
}
