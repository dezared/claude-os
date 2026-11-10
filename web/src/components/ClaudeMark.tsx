import { siClaude } from 'simple-icons';
import { cn } from '@/lib/format';

/** Marks anything Claude itself will run. */
export function ClaudeMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor" className={cn('flex-none text-accent', className)}>
      <path d={siClaude.path} />
    </svg>
  );
}
