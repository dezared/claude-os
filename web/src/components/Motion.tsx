import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { LEAVE_MS, usePresence } from '@/lib/motion';

/** A small thing that pops in and out (an icon, a mark; `fade` for a word): it stays for its exit after `show` turns false. */
export function Pop({ show, fade, className, children }: { show: boolean; fade?: boolean; className?: string; children: ReactNode }) {
  const { mounted, leaving } = usePresence(show);
  if (!mounted) return null;
  return <span className={cn(fade ? 'motion-fade' : 'motion-pop', leaving && 'is-leaving', className)}>{children}</span>;
}

/** A part that unfolds to its own height under what opened it, and folds back before it unmounts (.motion-fold). */
export function Fold({ show, className, children }: { show: boolean; className?: string; children: ReactNode }) {
  const { mounted, leaving } = usePresence(show, 220);
  if (!mounted) return null;
  return <div className={cn('motion-fold', leaving && 'is-leaving')}><div className={className}>{children}</div></div>;
}

/**
 * A number that rolls to its next value: the new one comes up from below as the old one leaves upwards (the other way when it
 * falls). The first value is simply there. Styles: .roll in styles.css.
 */
export function Roll({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const [old, setOld] = useState<{ value: number; up: boolean } | null>(null);
  if (value !== shown) {
    setOld({ value: shown, up: value > shown });
    setShown(value);
  }
  useEffect(() => {
    if (!old) return;
    const timer = window.setTimeout(() => setOld(null), LEAVE_MS + 40);
    return () => clearTimeout(timer);
  }, [old]);
  return (
    <span className={cn('roll', old && (old.up ? 'is-up' : 'is-down'), className)}>
      <span key={shown} className={cn(old && 'roll-in')}>{shown}</span>
      {old && <span key={`was-${old.value}`} aria-hidden className="roll-out">{old.value}</span>}
    </span>
  );
}
