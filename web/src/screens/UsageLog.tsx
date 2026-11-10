import { BookMarked, ExternalLink, Pencil, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Boundary, Empty } from '@/components/states';
import { Input, Segmented } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDateTime, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { Project, UsageEntry } from '@/lib/types';
import { skillNameMenu } from './admin/menus';

export function usageIcon(e: UsageEntry) {
  if (e.kind === 'skill') return <Sparkles size={11} className="flex-none text-dim" />;
  if (e.op === 'write') return <Pencil size={11} className="flex-none text-accent" />;
  return e.kind === 'external' ? <ExternalLink size={11} className="flex-none text-dim" /> : <BookMarked size={11} className="flex-none text-dim" />;
}

const shortTarget = (e: UsageEntry) => (e.kind === 'skill' ? e.target : shortPath(e.target));

/** Skill calls and memory accesses, from the journals. No hooks. */
export function UsageLog() {
  const [kind, setKind] = useState<'all' | UsageEntry['kind']>('all');
  const [project, setProject] = useState<string | null>(null);
  const [session, setSession] = useState('');
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const status = useApi<{ backfilling: boolean }>('/api/usage-log/status', ['usage']);
  const params = new URLSearchParams({ limit: '300' });
  if (kind !== 'all') params.set('kind', kind);
  if (project) params.set('project', project);
  if (session.trim()) params.set('session', session.trim());
  const log = useApi<UsageEntry[]>(`/api/usage-log?${params}`, ['usage']);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel={t('usage.kindAria')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('usage.all') },
            { value: 'skill', label: t('usage.skills') },
            { value: 'vault', label: t('usage.vault') },
            { value: 'external', label: t('usage.external') },
          ]}
        />
        <ProjectSelect className="w-52 text-xs" ariaLabel={t('settings.project')} value={project} onChange={setProject} projects={projects.data ?? []} extra={[{ value: null, label: t('usage.allProjects') }]} />
        <Input aria-label={t('usage.session')} placeholder={t('usage.session')} value={session} onChange={(e) => setSession(e.target.value)} className="w-72 py-1 font-mono text-xs" spellCheck={false} />
      </div>
      <p className="mb-2 max-w-4xl text-[11px] leading-[1.45] text-dim">
        {t('usage.note')}
        {status.data?.backfilling ? ` ${t('usage.backfilling')}` : ''}
      </p>
      <Boundary query={log} empty={(l) => (l.length === 0 ? <Empty>{t('usage.empty')}</Empty> : null)}>
        {(list) => (
          <div className="max-h-96 overflow-auto">
            <table className="w-full table-fixed text-xs">
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className="border-t border-line2 align-baseline">
                    <td className="w-28 py-1 text-dim">{e.at ? fmtDateTime(e.at) : '–'}</td>
                    <td className="w-16 py-1 text-muted">{e.tool}</td>
                    <td className="truncate py-1 font-mono text-[11px] text-soft" title={e.target}><span className="inline-flex max-w-full items-center gap-1.5"><span className="flex-none">{usageIcon(e)}</span>{e.kind === 'skill' ? <ContextArea items={() => skillNameMenu(e.target.split(':').at(-1) ?? e.target)}><span className="truncate">{shortTarget(e)}</span></ContextArea> : <span className="truncate">{shortTarget(e)}</span>}</span></td>
                    <td className="w-32 truncate py-1 text-[11px] text-dim" title={e.project ?? undefined}>{e.project ?? '–'}</td>
                    <td className="w-24 py-1 text-right font-mono text-[11px]">
                      <button type="button" className="press text-dim hover:text-fg" title={e.session} onClick={() => setSession(e.session)}>{e.session.slice(0, 8)}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Boundary>
    </div>
  );
}
