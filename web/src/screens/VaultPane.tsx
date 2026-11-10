import { ArchiveRestore, BookOpen, CircleAlert, FileWarning, FolderCheck, Notebook } from 'lucide-react';
import { useState } from 'react';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtInt, shortPath } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { toast, toastError } from '@/lib/store';
import type { MemoryGraph, MemoryNode, Project, SettingsView, VaultStatus } from '@/lib/types';
import { useProjectColors } from '@/lib/projectColors';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { issueLabel } from '@/home/NotePanel';
import { AskClaude, PanelBar, SectionHead, Stat, StatStrip } from './admin/parts';
import { MigrateCell, WikiMigration } from './WikiMigration';

const OVER_LIMIT = 180; // Claude Code's memory scan sees only the first 200 files

function IssuesStat({ nodes }: { nodes: MemoryNode[] }) {
  const flagged = nodes.filter((n) => n.issues.length > 0).length;
  return <Stat icon={FileWarning} tone={flagged > 0 ? 'warn' : undefined} label={t('memory.wiki.formatIssues')} value={fmtInt(flagged)} hint={tn('unit.note', flagged)} />;
}

/** Per vault project: how many notes, which format issues, whether it outgrew the scan, and its wiki migration. */
function FormatIssues({ nodes, names }: { nodes: MemoryNode[]; names: Map<string, string> }) {
  const { color } = useProjectColors();
  const projects = useApi<Project[]>('/api/projects', ['projects']).data ?? [];
  const [migrating, setMigrating] = useState<string | null>(null);
  const byProject = new Map<string | null, { notes: number; codes: Map<string, number> }>();
  for (const n of nodes.filter((x) => x.file !== 'MEMORY.md')) { // the generated index is no note
    const row = byProject.get(n.project) ?? { notes: 0, codes: new Map<string, number>() };
    row.notes++;
    for (const c of n.issues) row.codes.set(c, (row.codes.get(c) ?? 0) + 1);
    byProject.set(n.project, row);
  }
  // A project without notes can still be migrated: it becomes managed with an empty preview.
  const others = projects.filter((p) => !p.misc && !p.folder && !byProject.has(p.key));
  if (byProject.size === 0 && others.length === 0) return null;
  const rows = [...byProject].sort((a, b) => b[1].notes - a[1].notes);
  const nameOf = (key: string) => names.get(key) ?? projects.find((p) => p.key === key)?.name ?? key;
  return (
    <section className="mt-6 max-w-5xl">
      <SectionHead icon={FileWarning} title={t('memory.wiki.formatIssues')} aside={others.length > 0 && (
        <ProjectSelect projects={others} value={null} onChange={setMigrating} ariaLabel={t('memory.wiki.migrateOther')} extra={[{ value: null, label: t('memory.wiki.otherProject') }]} className="text-xs" />
      )} />
      {rows.length > 0 && <table aria-label={t('memory.wiki.formatIssues')} className="w-full table-fixed text-xs">
        <thead className="text-[11px] text-dim">
          <tr>
            <th className="w-56 py-1 text-left font-normal">{t('vault.colProject')}</th>
            <th className="w-40 py-1 text-right font-normal">{t('memory.wiki.colNotes')}</th>
            <th className="py-1 pl-6 text-left font-normal">{t('memory.wiki.formatIssues')}</th>
            <th className="w-40 py-1 text-right font-normal"><span className="sr-only">{t('memory.wiki.migrate')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, r]) => (
            <tr key={key ?? ''} className="border-t border-line2">
              <td className="truncate py-1.5 text-soft">
                {key === null ? t('universe.globalGroup') : <span className="inline-flex max-w-full items-center gap-2"><ProjectIcon project={key} name={names.get(key) ?? key} color={color(key)} size={15} /><span className="truncate">{names.get(key) ?? key}</span></span>}
              </td>
              <td className="py-1.5 text-right text-muted">
                {r.notes > OVER_LIMIT && <span className="mr-2 text-warn" title={t('memory.wiki.overLimitHint')}>{t('memory.wiki.overLimit', { n: fmtInt(OVER_LIMIT) })}</span>}
                {fmtInt(r.notes)}
              </td>
              <td className="py-1.5 pl-6 text-muted">
                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {[...r.codes].sort((a, b) => b[1] - a[1]).map(([code, n]) => <span key={code}>{issueLabel(code)} <b className="font-medium text-soft">{fmtInt(n)}</b></span>)}
                </span>
              </td>
              <td className="py-1.5 text-right">{key !== null && <MigrateCell project={key} onOpen={() => setMigrating(key)} />}</td>
            </tr>
          ))}
        </tbody>
      </table>}
      <WikiMigration project={migrating} name={migrating ? nameOf(migrating) : ''} onClose={() => setMigrating(null)} />
    </section>
  );
}

export function VaultPane() {
  const q = useApi<VaultStatus>('/api/memory/vault', ['memory']);
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const { color } = useProjectColors();
  const [busy, setBusy] = useState(false);
  const obsidian = settings.data?.obsidian.installed;

  const copy = async () => {
    setBusy(true);
    try {
      const r = await api<{ copied: number; conflicts: number }>('/api/memory/vault/copy', { method: 'POST' });
      toast(t('vault.copied', { n: fmtInt(r.copied), conflicts: fmtInt(r.conflicts) }));
      q.refetch();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Boundary query={q} errorClassName="m-5" skeleton={<Skeleton className="p-5" lines={8} />}>
        {(v) => {
          const total = v.projects.reduce((s, p) => s + p.newFiles.length, 0);
          const conflicts = v.projects.reduce((s, p) => s + p.conflicts.length, 0);
          // What really lies in the vault: Claude OS sessions write there without touching the project's settings.
          const inVault = (graph.data?.nodes ?? []).filter((n) => n.connected);
          const notes = inVault.length;
          const connected = new Set(inVault.map((n) => n.project)).size;
          const context = `Vault at ${v.path}. ${notes} notes in ${connected} projects. ${total} notes still outside, ${conflicts} conflicts.`;
          return (
            <>
              <PanelBar><AskClaude task="admin-vault" vars={{ context }} /></PanelBar>
              <StatStrip cols={5}>
                <Stat hero icon={Notebook} tone="accent" label={t('adm.vaultNotes')} value={fmtInt(notes)} />
                <Stat icon={FolderCheck} tone="ok" label={t('adm.vaultConnected')} value={fmtInt(connected)} />
                <Stat icon={ArchiveRestore} label={t('adm.vaultOutside')} value={fmtInt(total)} />
                <Stat icon={CircleAlert} tone={conflicts > 0 ? 'warn' : undefined} label={t('adm.vaultConflicts')} value={fmtInt(conflicts)} />
                <IssuesStat nodes={inVault} />
              </StatStrip>
              <div className="px-5 py-4">
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
              <FormatIssues nodes={inVault} names={new Map(v.projects.map((p) => [p.project, p.name]))} />
              </div>
            </>
          );
        }}
      </Boundary>
    </div>
  );
}
