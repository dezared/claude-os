import { FolderTree, Globe, Puzzle, Sparkles, Webhook, Zap } from 'lucide-react';
import { useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { fmtInt, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { useApp } from '@/lib/store';
import type { HookAdminRow, HooksReport } from '@/lib/types';
import { analyzeItem, hookId, hookMenu, writeHook } from './admin/menus';
import { Bar, PanelBar, ProjectGroups, SectionHead, SourceTag, Stat, StatStrip, type Scope } from './admin/parts';

const scopeOf = (h: HookAdminRow) => (h.scope === 'plugin' ? h.plugin ?? t('adm.scopePlugin') : h.scope === 'user' ? t('adm.scopeGlobal') : h.scope === 'local' ? t('adm.scopeLocal') : t('adm.scopeShared'));

export function HookLine({ h }: { h: HookAdminRow }) {
  const { nameOf } = useProjectColors();
  return (
    <ContextArea items={() => hookMenu(h)}>
      <button
        type="button"
        onClick={() => useApp.getState().go({ kind: 'entity', type: 'hook', id: hookId(h), ...(h.project ? { project: h.project } : {}) })}
        className="press grid w-full grid-cols-[150px_120px_minmax(0,1fr)_180px] items-center gap-3 border-b border-line2 px-5 py-1.5 text-left text-xs hover:bg-white/[.04]"
      >
        <span className="truncate text-soft">{h.event}</span>
        <span className="truncate font-mono text-[11px] text-dim" title={h.matcher ?? undefined}>{h.matcher ?? t('adm.hookAny')}</span>
        <code className="truncate font-mono text-[11px] text-muted" title={`${h.summary}\n${shortPath(h.file)}`}>{h.summary}</code>
        <span className="flex min-w-0 justify-end">
          {h.scope === 'user' ? <SourceTag kind="global" /> : h.scope === 'plugin' ? <SourceTag kind="plugin" name={h.plugin} /> : <SourceTag kind={h.scope} project={h.project} name={nameOf(h.project)} />}
        </span>
      </button>
    </ContextArea>
  );
}

export function HooksPane() {
  const q = useApi<HooksReport>('/api/admin/hooks', ['settings', 'skills']);
  const [scope, setScope] = useState<Scope>('global');
  const items = () => {
    const rows = q.data?.rows ?? [];
    const context = [`${rows.length} hooks.`, ...rows.slice(0, 40).map((h) => `- ${h.event}${h.matcher ? ` (${h.matcher})` : ''}, ${scopeOf(h)}${h.project ? ` in ${h.project}` : ''}: ${h.summary}`)].join('\n');
    return [
      { id: 'hooks.write', label: t('ent.writeHook'), icon: Sparkles, onSelect: writeHook },
      analyzeItem(t('ent.analyzeHooks'), 'hook list', 'Claude Code hooks', context, [t('ent.presetHooksWhat'), t('ent.presetHooksSlow'), t('ent.presetHooksRisk')]),
    ];
  };
  return (
    <ContextArea items={items} className="min-h-0 flex-1 overflow-auto">
      <Boundary query={q} skeleton={<Skeleton className="p-5" lines={8} />}>
        {(r) => {
          const shared = r.rows.filter((h) => h.project === null);
          const events = [...new Set(r.rows.map((h) => h.event))].map((event) => ({ event, n: shared.filter((h) => h.event === event).length, all: r.rows.filter((h) => h.event === event).length })).sort((a, b) => b.all - a.all);
          const max = Math.max(1, ...events.map((e) => e.all));
          const user = shared.filter((h) => h.scope === 'user').length;
          const plugin = shared.filter((h) => h.scope === 'plugin').length;
          const inProjects = r.rows.length - shared.length;
          return (
            <>
              <PanelBar scope={scope} onScope={setScope} />
              {scope === 'projects' ? (
                <ProjectGroups rows={r.projects} unit={t('adm.unitHooks')} empty={t('adm.noProjectHooks')}>
                  {(d) => r.rows.filter((h) => h.project === (d.project ?? d.root)).map((h, i) => <HookLine key={i} h={h} />)}
                </ProjectGroups>
              ) : (
                <>
                  <StatStrip cols={4}>
                    <Stat hero icon={Webhook} tone="accent" label={t('adm.hooksTotal')} value={fmtInt(r.rows.length)} hint={t('adm.hooksNoRuns')} />
                    <Stat icon={Globe} label={t('adm.scopeGlobal')} value={fmtInt(user)} />
                    <Stat icon={Puzzle} label={t('adm.scopePlugins')} value={fmtInt(plugin)} />
                    <Stat icon={FolderTree} label={t('adm.scopeInProjects')} value={fmtInt(inProjects)} hint={t('adm.inNProjects', { n: fmtInt(r.projects.length) })} />
                  </StatStrip>
                  {events.length === 0 ? <Empty className="m-5" icon={Webhook}>{t('adm.noHooks')}</Empty> : (
                    <>
                      <section className="border-b border-line2 px-5 py-4">
                        <SectionHead icon={Zap} title={t('adm.byEvent')} />
                        <div className="grid max-w-3xl gap-1.5">
                          {events.map((e) => (
                            <div key={e.event} className="grid grid-cols-[170px_minmax(0,1fr)_32px] items-center gap-3 text-xs">
                              <span className="truncate text-muted">{e.event}</span>
                              <Bar value={e.all} max={max} color="var(--color-accent)" />
                              <span className="text-right text-soft">{fmtInt(e.all)}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                      {shared.map((h, i) => <HookLine key={i} h={h} />)}
                    </>
                  )}
                </>
              )}
            </>
          );
        }}
      </Boundary>
    </ContextArea>
  );
}
