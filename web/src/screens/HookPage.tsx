import { Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import type { HooksReport } from '@/lib/types';
import { Facts, Section, when } from './admin/entityParts';
import { hookContext, hookId, hookMenu, hookTitle } from './admin/menus';
import { EntityShell, type EntityPageProps } from './EntityPage';

export default function HookPage(props: EntityPageProps) {
  const report = useApi<HooksReport>('/api/admin/hooks', ['settings', 'skills']);
  const { nameOf } = useProjectColors();
  const h = report.data?.rows.find((x) => hookId(x) === props.id);
  // The page of a hook no one can find any more should not print the whole id as its name.
  const title = h ? hookTitle(h) : props.id.split('\n')[1] ?? props.id;
  const scope = h && (h.scope === 'plugin' ? t('ent.scopePluginHint', { name: h.plugin ?? '' }) : h.scope === 'user' ? t('ent.scopeGlobalHint') : t(h.scope === 'local' ? 'ent.scopeLocalHint' : 'ent.scopeSharedHint', { name: nameOf(h.project) }));
  return (
    <EntityShell {...props} title={title} context={h && hookContext(h)} menu={h && hookMenu(h, { page: true })}>
      {!h ? (report.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />) : (
        <>
          <Facts rows={[
            [t('ent.scope'), scope],
            [t('ent.hookEvent'), h.event],
            [t('ent.hookMatcher'), h.matcher ?? t('adm.hookAny')],
            [t('ent.hookType'), h.type],
            [t('ent.path'), <code className="font-mono text-[11.5px]">{h.file}</code>],
            [t('ent.fileChanged'), when(h.changedAt)],
          ]} />
          <Section title={t('ent.hookCommand')}>
            <pre className="selectable overflow-auto rounded-md border border-line2 bg-bg p-3 font-mono text-[11.5px] whitespace-pre-wrap wrap-anywhere text-soft">{h.summary}</pre>
          </Section>
          <p className="text-[11px] text-dim">{t('adm.hooksNoRuns')}</p>
        </>
      )}
    </EntityShell>
  );
}
