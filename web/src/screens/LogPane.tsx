import { BookMarked, BookOpenCheck, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Diff } from '@/components/Diff';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { cn, fmtDateTime, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { AuditEntry } from '@/lib/types';
import { SectionHead } from './admin/parts';
import { UsageLog } from './UsageLog';

function AuditRow({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line2">
      <button type="button" aria-expanded={e.diff ? open : undefined} disabled={!e.diff} onClick={() => setOpen(!open)} className="press flex w-full items-center gap-3 py-1.5 text-left text-xs enabled:hover:bg-white/[.04]">
        <ChevronRight size={11} className={cn('flex-none text-dim transition-transform duration-150', open && 'rotate-90', !e.diff && 'opacity-0')} />
        <span className="w-28 flex-none text-dim">{fmtDateTime(e.at)}</span>
        <span className="w-44 flex-none truncate text-muted">{e.action}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim" title={e.target}>{shortPath(e.target)}</span>
      </button>
      {open && e.diff && (
        <div className="pb-2 pl-6">
          <Diff diff={e.diff} maxHeight={240} />
        </div>
      )}
    </div>
  );
}

/** Who read what, and what Claude OS itself changed. */
export function LogPane() {
  const audit = useApi<AuditEntry[]>('/api/audit', ['audit']);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section className="border-b border-line2 px-5 py-4">
        <SectionHead icon={BookMarked} title={t('usage.title')} />
        <UsageLog />
      </section>
      <section className="px-5 py-4">
        <SectionHead icon={BookOpenCheck} title={t('an.auditTitle')} />
        <Boundary query={audit} skeleton={<Skeleton lines={4} />} empty={(l) => (l.length === 0 ? <Empty>{t('an.auditEmpty')}</Empty> : null)}>
          {(list) => (
            <div className="max-h-96 overflow-auto">
              {list.slice().sort((a, b) => b.at - a.at).slice(0, 200).map((e) => <AuditRow key={e.id} e={e} />)}
            </div>
          )}
        </Boundary>
      </section>
    </div>
  );
}
