import { useEffect, useState } from 'react';
import { Diff } from '@/components/Diff';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Dialog } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtInt, shortPath } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { toast } from '@/lib/store';
import type { MemoryMigrationPlan } from '@/lib/types';

/** Plan first, then the explicit confirmation: this writes outside the repo. */
export function MigrateDialog({ project, onClose }: { project: string | null; onClose: () => void }) {
  const [plan, setPlan] = useState<MemoryMigrationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!project) return;
    setPlan(null);
    setError(null);
    api<MemoryMigrationPlan>(`/api/memory/migrate/${encodeURIComponent(project)}`)
      .then(setPlan)
      .catch((e: Error) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [project]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: true; copied: number; skipped?: string[] }>(`/api/memory/migrate/${encodeURIComponent(project!)}`, { method: 'POST' });
      const skipped = res.skipped?.length ? t('migrate.skipped', { n: fmtInt(res.skipped.length), list: res.skipped.join(', ') }) : '';
      toast(t('migrate.done', { n: fmtInt(res.copied), files: tn('unit.file', res.copied) }) + skipped);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()} title={t('migrate.title')} description={project ?? undefined} width={620}>
      {error && <ErrorState message={error} onRetry={plan ? undefined : load} className="mb-3" />}
      {!plan && !error && <Skeleton lines={6} />}
      {plan && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-dim">{t('migrate.from')}</dt>
            <dd className="selectable truncate font-mono text-muted" title={plan.from}>{shortPath(plan.from)}</dd>
            <dt className="text-dim">{t('migrate.to')}</dt>
            <dd className="selectable truncate font-mono text-muted" title={plan.to}>{shortPath(plan.to)}</dd>
          </dl>
          <div>
            <div className="mb-1 text-xs text-muted">
              {t('migrate.willCopy')} <span className="font-mono">{fmtInt(plan.files.length)}</span> {tn('unit.file', plan.files.length)}
            </div>
            <ul className="selectable max-h-32 overflow-auto rounded-md border border-line2 bg-bg px-3 py-2 font-mono text-[11.5px] text-muted">
              {plan.files.map((f) => (
                <li key={f} className="truncate">{f}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 truncate text-xs text-muted" title={plan.settingsPath}>
              {t('migrate.changeIn')} <span className="font-mono">{shortPath(plan.settingsPath)}</span>
            </div>
            <Diff diff={plan.settingsDiff} maxHeight={180} />
          </div>
          <p className="text-xs text-dim">{t('migrate.note')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={apply}>
              {t('migrate.action')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
