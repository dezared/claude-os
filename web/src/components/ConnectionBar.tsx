import { Check, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { usePresence } from '@/lib/motion';
import { useApp } from '@/lib/store';

const RESTORED_MS = 2500;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Since when the server has been away, and whether it came back a moment ago. */
function useOutage(): { since: number | null; restored: boolean } {
  const connection = useApp((s) => s.connection);
  const since = useRef<number | null>(null);
  const [restored, setRestored] = useState(false);
  if (connection === 'offline' && since.current === null) since.current = Date.now();
  useEffect(() => {
    if (connection !== 'online' || since.current === null) return;
    since.current = null;
    setRestored(true);
    const id = setTimeout(() => setRestored(false), RESTORED_MS);
    return () => clearTimeout(id);
  }, [connection]);
  return { since: connection === 'offline' ? since.current : null, restored };
}

/** A live line while the server is away: how long, that reconnecting goes on, and a short word when it is back. */
export function ConnectionBar({ edge }: { edge: 'top' | 'bottom' }) {
  const { since, restored } = useOutage();
  const offline = since !== null;
  const { mounted, leaving } = usePresence(offline || restored);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [offline]);
  if (!mounted) return null;
  return (
    <div role="status" data-testid="connection-bar" className={cn('motion-fade flex flex-none items-center gap-2 border-line2 bg-banner py-1 text-xs text-soft', edge === 'top' ? 'border-b px-4' : 'border-t px-3', leaving && 'is-leaving')}>
      {offline ? <WifiOff size={12} className="dot-working flex-none text-accent" /> : <Check size={12} className="flex-none text-ok" />}
      <span key={offline ? 'off' : 'on'} className={cn('enter-fade', offline && 'text-shimmer')}>{offline ? t('app.offline') : t('app.reconnected')}</span>
      {offline && <span className="text-dim tabular-nums">{fmtElapsed(now - since)}</span>}
    </div>
  );
}
