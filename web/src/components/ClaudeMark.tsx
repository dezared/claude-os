import { siClaude } from 'simple-icons';
import { cn } from '@/lib/format';

/** Marks anything Claude itself will run. Claude's own colour, not the accent: the mark stays the same whichever accent is picked. */
export function ClaudeMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor" className={cn('flex-none text-[#d97757] light:text-[#c15f3c]', className)}>
      <path d={siClaude.path} />
    </svg>
  );
}
