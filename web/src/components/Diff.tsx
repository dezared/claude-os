import { memo, useMemo } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { truncatedLines } from '@/lib/serverLines';

/** Unified diff. Added lines carry the accent, removed ones recede: the palette has one accent only. */
export const Diff = memo(function Diff({ diff, maxHeight = 320 }: { diff: string; maxHeight?: number }) {
  const lines = useMemo(() => diff.split('\n'), [diff]);
  if (!diff.trim()) return <div className="rounded-md border border-dashed border-line p-3 text-xs text-dim">{t('diff.none')}</div>;
  return (
    <pre className="selectable overflow-auto rounded-md border border-line2 bg-bg py-2 font-mono text-[12px] leading-[1.55]" style={{ maxHeight }}>
      {lines.map((line, i) => {
        const head = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ');
        const add = !head && line.startsWith('+');
        const del = !head && line.startsWith('-');
        const cut = truncatedLines(line);
        return (
          <div
            key={i}
            className={cn(
              'min-w-fit px-3 whitespace-pre',
              head && 'text-dim',
              add && 'bg-accent-bg text-[#f0b8a3]',
              del && 'bg-zinc-800/50 text-zinc-500 line-through decoration-zinc-600',
              !head && !add && !del && 'text-muted',
            )}
          >
            {cut !== null ? t('diff.truncated', { n: cut }) : line || ' '}
          </div>
        );
      })}
    </pre>
  );
});
