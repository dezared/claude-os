import { ArchiveRestore, BookOpen, FileWarning, FolderCheck, Notebook, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtInt, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import { reducedMotion } from '@/lib/motion';
import { toast, toastError } from '@/lib/store';
import type { MemoryOverview, MemoryProjectStats, Project, SettingsView, VaultStatus } from '@/lib/types';
import { useProjectColors } from '@/lib/projectColors';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { AskClaude, PanelBar, Stat, StatStrip } from './admin/parts';
import { StorageNotes } from './storage/StorageNotes';
import { StorageProjects, type Filter } from './storage/StorageProjects';
import { WikiMigration } from './WikiMigration';

/** Vault notes still to move and the old-place sources behind them: copied once, project settings stay. */
function VaultImport({ v, onCopied }: { v: VaultStatus; onCopied: () => void }) {
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const { color } = useProjectColors();
  const [busy, setBusy] = useState(false);
  const obsidian = settings.data?.obsidian.installed;
  const total = v.projects.reduce((s, p) => s + p.newFiles.length, 0);
  const conflicts = v.projects.reduce((s, p) => s + p.conflicts.length, 0);
  const copy = async () => {
    setBusy(true);
    try {
      const r = await api<{ copied: number; conflicts: number }>('/api/memory/vault/copy', { method: 'POST' });
      toast(t('vault.copied', { n: fmtInt(r.copied), conflicts: fmtInt(r.conflicts) }));
      onCopied();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-8 max-w-6xl border-t border-line2 pt-5">
      <div className="mb-4 max-w-3xl">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium"><BookOpen size={14} className="text-dim" />{t('vault.title')}</div>
        <code className="selectable mb-2 block font-mono text-xs wrap-anywhere text-soft">{shortPath(v.path)}{v.exists ? '' : ` · ${t('vault.notCreated')}`}</code>
        <p className="mb-1.5 text-xs leading-[1.55] text-muted">{t('vault.explain')}</p>
        <p className="text-xs leading-[1.55] text-dim">{obsidian === false ? t('vault.obsidianMissing') : obsidian === true ? t('vault.obsidianFound') : t('settings.obsidianUnknown')}</p>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={busy || total === 0} onClick={copy}><ArchiveRestore size={13} />{t('vault.copyAll')}</Button>
        <span className="text-xs text-muted">{total === 0 ? t('vault.nothing') : t('vault.preview', { n: fmtInt(total), p: fmtInt(v.projects.filter((p) => p.newFiles.length > 0).length) })}</span>
        {conflicts > 0 && <span className="text-xs text-accent" title={t('vault.conflictsHint')}>{t('vault.conflicts', { n: fmtInt(conflicts) })}</span>}
      </div>
      {v.projects.length === 0 ? <Empty>{t('vault.noSources')}</Empty> : (
        <table className="w-full max-w-5xl table-fixed text-xs">
          <thead className="text-[11px] text-dim">
            <tr>
              <th className="py-1 text-left font-normal">{t('vault.colProject')}</th>
              <th className="w-24 py-1 text-right font-normal">{t('vault.colNew')}</th>
              <th className="w-24 py-1 text-right font-normal">{t('vault.colThere')}</th>
              <th className="w-24 py-1 text-right font-normal">{t('vault.colConflict')}</th>
            </tr>
          </thead>
          <tbody>
            {v.projects.map((p) => (
              <tr key={p.project} className="border-t border-line2">
                <td className="truncate py-1.5 text-soft" title={p.newFiles.join(', ') || p.to}><span className="inline-flex max-w-full items-center gap-2"><ProjectIcon project={p.project} name={p.name} color={color(p.project)} size={15} /><span className="truncate">{p.name}</span></span></td>
                <td className="py-1.5 text-right text-muted">{fmtInt(p.newFiles.length)}</td>
                <td className="py-1.5 text-right text-dim">{fmtInt(p.existing)}</td>
                <td className="py-1.5 text-right text-dim" title={p.conflicts.join(', ')}>{p.conflicts.length ? fmtInt(p.conflicts.length) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The figures over the panel: the whole memory, not the map's subset. */
function Stats({ o, outside }: { o: MemoryOverview; outside: number }) {
  const sum = (f: (p: MemoryProjectStats) => number) => o.projects.reduce((n, p) => n + f(p), 0);
  const inVault = o.total - sum((p) => p.outside);
  const malformed = sum((p) => p.health.malformed);
  const needCare = sum((p) => p.health.broken + p.health.duplicate);
  return (
    <StatStrip cols={5}>
      <Stat hero icon={Notebook} tone="accent" label={t('adm.vaultNotes')} value={fmtInt(inVault)} hint={t('storage.allIndexed')} />
      <Stat icon={FolderCheck} tone="ok" label={t('storage.projects')} value={fmtInt(o.projects.filter((p) => p.project !== null).length)} />
      <Stat icon={TrendingUp} label={t('storage.week')} value={`+${fmtInt(sum((p) => p.added7))}`} hint={t('storage.month', { n: fmtInt(sum((p) => p.added30)) })} />
      <Stat icon={ArchiveRestore} label={t('adm.vaultOutside')} value={fmtInt(outside)} />
      <Stat icon={FileWarning} tone={malformed > 0 ? 'warn' : undefined} label={t('memory.wiki.formatIssues')} value={fmtInt(malformed)} hint={t('storage.needCare', { n: fmtInt(needCare) })} />
    </StatStrip>
  );
}

export function VaultPane() {
  const q = useApi<VaultStatus>('/api/memory/vault', ['memory']);
  const overview = useApi<MemoryOverview>('/api/memory/overview', ['memory']);
  const all = useApi<Project[]>('/api/projects', ['projects']).data ?? [];
  const [filter, setFilter] = useState<Filter & { seq: number }>({ seq: 0 });
  const [migrating, setMigrating] = useState<string | null>(null);
  const names = new Map(all.map((p) => [p.key, p.name]));
  const nameOf = (key: string | null) => (key === null ? t('universe.globalGroup') : names.get(key) ?? key);
  // A project without notes can still be migrated: it becomes managed with an empty preview.
  const others = all.filter((p) => !p.misc && !p.folder && !overview.data?.projects.some((s) => s.project === p.key));
  const onFilter = (f: Filter) => {
    setFilter((was) => ({ ...f, seq: was.seq + 1 }));
    document.getElementById('storage-notes')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Boundary query={overview} errorClassName="m-5" skeleton={<Skeleton className="p-5" lines={8} />}>
        {(o) => {
          const outside = (q.data?.projects ?? []).reduce((s, p) => s + p.newFiles.length, 0);
          const context = `Vault at ${q.data?.path ?? '?'}. ${o.total} notes in ${o.projects.length} projects. `
            + o.projects.slice(0, 12).map((p) => `${p.project ?? 'global'}: ${p.notes} notes, +${p.added7} this week, ${p.health.malformed} malformed, ${p.health.duplicate} duplicates`).join('; ')
            + `. ${outside} notes still outside the vault.`;
          return (
            <>
              <PanelBar><AskClaude task="admin-vault" vars={{ context }} /></PanelBar>
              <Stats o={o} outside={outside} />
              <div className="px-5 py-4">
                <StorageProjects projects={o.projects} nameOf={nameOf} vaultPath={q.data?.path ?? ''} onFilter={onFilter} onMigrate={setMigrating}
                  aside={others.length > 0 && <ProjectSelect projects={others} value={null} onChange={setMigrating} ariaLabel={t('memory.wiki.migrateOther')} extra={[{ value: null, label: t('memory.wiki.otherProject') }]} className="text-xs" />} />
                <div id="storage-notes" className="scroll-mt-14"><StorageNotes projects={o.projects} nameOf={nameOf} filter={filter} /></div>
                {q.data && <VaultImport v={q.data} onCopied={() => { q.refetch(); overview.refetch(); }} />}
                <WikiMigration project={migrating} name={migrating ? nameOf(migrating) : ''} onClose={() => setMigrating(null)} />
              </div>
            </>
          );
        }}
      </Boundary>
    </div>
  );
}
