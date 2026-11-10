import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Boundary, Skeleton } from '@/components/states';
import { Button, Dialog, Input } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { toast, toastError } from '@/lib/store';
import type { ProjectRemovalPreview, ProjectRemovalResult, RemovalItem } from '@/lib/types';

const kindKey: Record<RemovalItem['kind'], Key> = { journals: 'remove.kind.journals', vault: 'remove.kind.vault', state: 'remove.kind.state' };

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function RemoveProjectDialog({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const preview = useApi<ProjectRemovalPreview>(`/api/projects/${encodeURIComponent(projectKey)}/removal`);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const remove = async (p: ProjectRemovalPreview) => {
    setBusy(true);
    try {
      await api<ProjectRemovalResult>(`/api/projects/${encodeURIComponent(projectKey)}/remove`, { method: 'POST', body: { confirm: typed } });
      toast(t('remove.done', { name: p.name }));
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('remove.title')} width={620}>
      <Boundary query={preview} skeleton={<Skeleton lines={5} />}>
        {(p) => {
          return (
            <div className="flex flex-col gap-3 text-[13px]">
              <div className="flex items-start gap-2 rounded-lg border border-[#c2410c]/60 bg-[#c2410c]/10 p-3 text-soft">
                <TriangleAlert size={15} className="mt-0.5 flex-none text-[#f97316]" />
                <p className="wrap-anywhere">{t('remove.lead', { name: p.name, root: p.root })}</p>
              </div>
              {p.items.length === 0 ? (
                <p className="text-muted">{t('remove.nothing')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {p.items.map((i) => (
                    <li key={i.path} className="rounded-lg bg-white/[.035] px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-soft">{t(kindKey[i.kind])}</span>
                        <span className="flex-none text-xs text-muted">{t('remove.files', { n: fmtInt(i.files) })} · {fmtSize(i.bytes)}</span>
                      </div>
                      <div className="selectable mt-0.5 font-mono text-[11.5px] wrap-anywhere text-dim">{i.path}</div>
                      {i.skipped && <div className="mt-0.5 text-xs text-[#f97316]">{i.skipped === 'shared_dir' ? t('remove.skipShared') : t('remove.skipSource')}</div>}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="flex flex-col gap-1 text-xs text-muted">
                {p.claudeJson.keys.length > 0 && p.claudeJson.safe && <li className="wrap-anywhere">{t('remove.claudeJsonOk', { path: p.claudeJson.path })}</li>}
                {p.claudeJson.keys.length > 0 && !p.claudeJson.safe && <li className="wrap-anywhere">{t('remove.claudeJsonSkip', { path: p.claudeJson.path })}</li>}
                {p.claudeJson.reason === 'unreadable' && <li className="wrap-anywhere">{t('remove.claudeJsonBad', { path: p.claudeJson.path })}</li>}
                {p.settingsKept && <li className="wrap-anywhere">{t('remove.settingsKept', { path: p.settingsKept })}</li>}
                {p.tabs > 0 && <li>{t('remove.tabs', { n: fmtInt(p.tabs) })}</li>}
                <li className="wrap-anywhere">{t('remove.trash', { path: p.trash })}</li>
              </ul>
              {p.liveCount > 0 ? (
                <p role="alert" className="text-[#f97316]">{t('remove.live', { n: fmtInt(p.liveCount) })}</p>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{t('remove.typeName', { name: p.name })}</span>
                  <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label={t('remove.typeName', { name: p.name })} />
                </label>
              )}
              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>{t('common.cancel')}</Button>
                <Button variant="danger" disabled={busy || p.liveCount > 0 || typed !== p.name} onClick={() => remove(p)}>
                  {t('remove.action')}
                </Button>
              </div>
            </div>
          );
        }}
      </Boundary>
    </Dialog>
  );
}
