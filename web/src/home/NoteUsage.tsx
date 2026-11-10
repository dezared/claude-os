import { useApi } from '@/lib/api';
import { fmtAgo, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { UsageTotals } from '@/lib/types';

/** Calls seen in the journals. MEMORY.md is loaded at session start without any call, so it would read as zero here. */
export function NoteUsage({ id, file }: { id: string; file: string }) {
  const q = useApi<UsageTotals>(`/api/memory/notes/${encodeURIComponent(id)}/usage`, ['usage']);
  if (!q.data) return null;
  const { reads, writes, last } = q.data;
  return (
    <p className="mt-2 text-[11px] leading-[1.45] text-dim" data-testid="note-usage">
      {t('note.usage', { reads: fmtInt(reads ?? 0), writes: fmtInt(writes ?? 0) })}
      {last ? ` · ${fmtAgo(last)}` : ''}
      {file === 'MEMORY.md' ? ` · ${t('note.usageIndex')}` : ''}
    </p>
  );
}
