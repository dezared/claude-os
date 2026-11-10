import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { MentionRow, MentionSource } from './mentionSources';

/** The rows of the @ menu, one flat list for the keyboard: sections, what they found, then the project's files. */
export function MentionMenu({ rows, active, setActive, opened, onPick, onBack }: { rows: MentionRow[]; active: number; setActive: (i: number) => void; opened: MentionSource | null; onPick: (row: MentionRow) => void; onBack: () => void }) {
  const firstFile = rows.findIndex((r) => r.kind === 'file');
  return (
    <>
      {opened && (
        <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onBack} className="press mb-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-dim hover:text-fg">
          <ChevronLeft size={11} className="flex-none" />
          <opened.icon size={11} className="flex-none" />
          <span className="min-w-0 flex-1 truncate">{t(opened.label)}</span>
          <span className="flex-none">{t('composer.sourceBack')}</span>
        </button>
      )}
      {rows.map((row, i) => (
        <div key={row.kind === 'file' ? `f:${row.path}` : row.kind === 'item' ? `i:${row.source.id}:${row.item.id}` : `s:${row.source.id}`} role="presentation">
          {i === firstFile && i > 0 && <div role="presentation" className="mt-1 border-t border-line2 px-2.5 pt-1.5 pb-0.5 text-[10.5px] text-dim">{t('composer.filesAria')}</div>}
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            onPointerMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(row)}
            className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs transition-colors duration-100', i === active ? 'bg-raised text-fg' : 'text-muted', row.kind === 'file' && 'font-mono')}
          >
            {row.kind === 'file' && (
              <>
                <FileText size={11} className="flex-none text-dim" />
                <span className="min-w-0 truncate">{row.path}</span>
              </>
            )}
            {row.kind === 'section' && (
              <>
                <row.source.icon size={12} className="flex-none text-accent" />
                <span className="min-w-0 flex-1 truncate">{t(row.source.label)}</span>
                <kbd className="flex-none rounded bg-white/[.07] px-1.5 font-sans text-[10.5px] leading-[1.6] text-dim">{t('composer.sourceOpen')}</kbd>
                <ChevronRight size={12} className="flex-none text-dim" />
              </>
            )}
            {row.kind === 'item' && (
              <>
                <row.source.icon size={11} className="flex-none text-dim" />
                <span className="flex-none font-mono text-[11px] text-soft">{row.item.id}</span>
                <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
                {row.item.hint && <span className="max-w-[30%] flex-none truncate text-[11px] text-dim">{row.item.hint}</span>}
              </>
            )}
          </button>
        </div>
      ))}
    </>
  );
}
