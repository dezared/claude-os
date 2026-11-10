import type { KitFileAction, KitPlan, KitPlanFile } from '../../../shared/projectKit.ts';
import { Diff } from '@/components/Diff';
import { Skeleton } from '@/components/states';
import { Button } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import type { RequestItem } from '@/lib/chat';
import { shortPath } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import { CardShell, Resolved, useRespond } from './RequestCards';

const ACTION_LABEL = {
  add: 'kit.action.add',
  update: 'kit.action.update',
  merge: 'kit.action.merge',
  'needs-merge': 'kit.action.needs-merge',
  keep: 'kit.action.keep',
  skip: 'kit.action.skip',
  remove: 'kit.action.remove',
  migrate: 'kit.action.migrate',
} satisfies Record<KitFileAction, Key>;

function FileRow({ f }: { f: KitPlanFile }) {
  const name = (
    <>
      {f.path}
      {f.reason && <span className="text-dim"> · {f.reason}</span>}
    </>
  );
  if (!f.diff) return <div className="truncate pl-3 font-mono text-[11.5px] text-muted" title={f.path}>{name}</div>;
  return (
    <details>
      <summary className="cursor-pointer truncate font-mono text-[11.5px] text-soft" title={f.path}>{name}</summary>
      <div className="mt-1 mb-2"><Diff diff={f.diff} maxHeight={260} /></div>
    </details>
  );
}

// Grouped by action in plan order, which is also the order of the writes.
function PlanFiles({ plan }: { plan: KitPlan }) {
  if (plan.empty) return <p className="mb-2 text-xs text-muted">{t('kit.nothing')}</p>;
  const groups = new Map<KitFileAction, KitPlanFile[]>();
  for (const f of plan.files) groups.set(f.action, [...(groups.get(f.action) ?? []), f]);
  return (
    <div className="mb-2 flex max-h-96 flex-col gap-2 overflow-auto rounded-md border border-line2 bg-bg p-2">
      {[...groups].map(([action, files]) => (
        <section key={action}>
          <div className="mb-0.5 text-[11px] text-dim">{t(ACTION_LABEL[action])} · {files.length}</div>
          {files.map((f) => <FileRow key={f.path} f={f} />)}
        </section>
      ))}
      {plan.skipped.length > 0 && <p className="text-[11px] text-dim">{t('kit.skipped', { list: plan.skipped.map((s) => s.skipped).join(', ') })}</p>}
    </div>
  );
}

function PendingCard({ tabId, requestId, planId }: { tabId: string; requestId: string; planId: string }) {
  const { busy, respond } = useRespond(tabId, requestId);
  const q = useApi<KitPlan>(`/api/project-kit/plans/${encodeURIComponent(planId)}`);
  const plan = q.data;
  const apply = async () => {
    try {
      await api(`/api/project-kit/plans/${encodeURIComponent(planId)}/approve`, { method: 'POST', body: { requestId } });
    } catch (e) {
      toastError(e);
      return;
    }
    await respond({ kind: 'permission', allow: true });
  };
  return (
    <CardShell pending title={plan ? t('kit.planTitle', { root: shortPath(plan.root) }) : t('kit.title')}>
      {q.error ? <p className="mb-2 text-xs text-dim">{t('kit.planGone')}</p> : plan ? <PlanFiles plan={plan} /> : <Skeleton lines={3} />}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !plan} onClick={apply}>
          {t('kit.apply')}
        </Button>
        <Button disabled={busy} onClick={() => respond({ kind: 'permission', allow: false })}>
          {t('kit.reject')}
        </Button>
      </div>
    </CardShell>
  );
}

/** The kit_apply permission card: the stored plan, never Claude's input. Apply sets the server-side approval first (ruling R4). */
export function KitPlanCard({ item, tabId }: { item: Extract<RequestItem, { type: 'permission' }>; tabId: string | null }) {
  const planId = String((item.input as { planId?: unknown } | null)?.planId ?? '');
  // A used plan is deleted, so only a pending card asks for it.
  if (tabId && item.decision === null) return <PendingCard tabId={tabId} requestId={item.requestId} planId={planId} />;
  return (
    <CardShell pending={false} title={t('kit.title')}>
      {item.decision !== null ? <Resolved decision={item.decision} /> : <div className="text-xs text-dim">{t('req.noAnswer')}</div>}
    </CardShell>
  );
}
