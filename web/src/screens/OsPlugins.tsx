import { Boxes, ClipboardCopy, Download, ExternalLink, FileCog, LayoutTemplate, Package, PackageCheck, PackagePlus, PanelTop, Plug, Power, PowerOff, RefreshCw, Server, Settings2, Sparkles, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea, claudeItems } from '@/components/ContextMenu';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button, Checkbox, Dialog } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { spendNote } from '@/lib/account';
import { api, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { locale, t, type Key } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { toast, toastError, useApp } from '@/lib/store';
import { createTab } from '@/lib/tabs';
import type { OsPluginChange, OsPluginDependency, OsPluginPlan, OsPluginRow, OsPluginSetup, OsPluginsReport } from '@/lib/types';
import { EntityShell, type EntityPageProps } from './EntityPage';
import { Tag } from './admin/parts';

const PATH = '/api/os-plugins';
const KIND: Record<OsPluginChange['kind'], { icon: typeof Plug; label: Key }> = {
  skill: { icon: Sparkles, label: 'osp.kindSkill' },
  hook: { icon: Webhook, label: 'osp.kindHook' },
  mcp: { icon: Plug, label: 'osp.kindMcp' },
  ui: { icon: PanelTop, label: 'osp.kindUi' },
  config: { icon: FileCog, label: 'osp.kindConfig' },
  kit: { icon: LayoutTemplate, label: 'osp.kindKit' },
};
const DEPENDENCY: Record<OsPluginDependency['kind'], { icon: typeof Plug; label: Key }> = {
  config: { icon: FileCog, label: 'osp.depKindConfig' },
  service: { icon: Server, label: 'osp.depKindService' },
  package: { icon: PackageCheck, label: 'osp.depKindPackage' },
  download: { icon: Download, label: 'osp.depKindDownload' },
};
const DEP_STATE: Record<OsPluginDependency['state'], { tone: 'ok' | 'warn' | undefined; label: Key }> = {
  met: { tone: 'ok', label: 'osp.depMet' },
  missing: { tone: 'warn', label: 'osp.depMissing' },
  unknown: { tone: undefined, label: 'osp.depUnknown' },
};
const VERBS = {
  enable: { title: 'osp.enableTitle', hint: 'osp.enableHint', done: 'osp.enabled', button: 'osp.enable', withSetup: 'osp.enableAndSetup' },
  update: { title: 'osp.updateTitle', hint: 'osp.updateHint', done: 'osp.updated', button: 'osp.update', withSetup: 'osp.updateAndSetup' },
  disable: { title: 'osp.disableTitle', hint: 'osp.disableHint', done: 'osp.disabled', button: 'osp.disable', withSetup: 'osp.disable' },
} as const satisfies Record<OsPluginPlan['action'], Record<string, Key>>;

const said = (en: string | null, ru: string | null) => (locale() === 'ru' ? ru ?? en : en);
const featuresOf = (p: OsPluginRow) => (locale() === 'ru' && p.featuresRu.length > 0 ? p.featuresRu : p.features);
const updatable = (p: OsPluginRow) => p.enabled && p.errors.length === 0 && (p.changed || (!!p.version && p.installedVersion !== p.version));

/** The same new tab the rest of the app opens for a job, so everything Claude does stays in sight. */
async function runSetup(setup: OsPluginSetup, plugin: string) {
  const tab = await createTab({ cwd: setup.cwd, title: setup.title, source: 'setup', sourceDetail: plugin });
  if (!tab) return;
  await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: setup.prompt } }).catch(toastError);
}

/** The manifest's own library icon through an img, which can run nothing; a plain box when it names none. */
function PluginIcon({ p, size = 32 }: { p: OsPluginRow; size?: number }) {
  const inner = Math.round(size * 0.56);
  return (
    <span aria-hidden className={cn('flex flex-none items-center justify-center rounded-lg bg-white/[.06] transition-opacity duration-150', !p.enabled && 'opacity-55')} style={{ width: size, height: size }}>
      {p.icon ? <img alt="" src={`data:image/svg+xml;utf8,${encodeURIComponent(p.icon)}`} style={{ width: inner, height: inner }} /> : <Package size={inner} className="text-dim" />}
    </span>
  );
}

function DependencyRow({ d }: { d: OsPluginDependency }) {
  const kind = DEPENDENCY[d.kind];
  const state = DEP_STATE[d.state];
  return (
    <li className="border-b border-line2 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <kind.icon size={12} className="flex-none text-dim" />
        <span className="text-soft">{said(d.title, d.titleRu)}</span>
        <Tag tone={state.tone}>{t(state.label)}</Tag>
        <span className="text-[11px] text-dim">{t(kind.label)} · {t(d.level === 'required' ? 'osp.depRequired' : 'osp.depRecommended')}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{said(d.why, d.whyRu)}</p>
      <div className="selectable mt-0.5 font-mono text-[11px] wrap-anywhere text-dim">{d.target}</div>
      {d.block && (
        <details className="mt-1 text-xs">
          <summary className="press w-fit cursor-pointer text-[11px] text-muted hover:text-fg">{t('osp.depBlock')}</summary>
          <pre className="enter-fade selectable mt-1 max-h-40 overflow-auto rounded-md border border-line2 bg-bg p-2.5 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-soft">{d.block}</pre>
        </details>
      )}
    </li>
  );
}

function SetupPrompt({ setup }: { setup: OsPluginSetup }) {
  return (
    <details className="text-xs">
      <summary className="press w-fit cursor-pointer text-[11px] text-muted hover:text-fg">{t('osp.setupPrompt')}</summary>
      <pre className="enter-fade selectable mt-1 max-h-48 overflow-auto rounded-md border border-line2 bg-bg p-2.5 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-soft">{setup.prompt}</pre>
    </details>
  );
}

function Dependencies({ list }: { list: OsPluginDependency[] }) {
  return (
    <section aria-label={t('osp.deps')}>
      <h3 className="mb-1 text-[11.5px] font-medium text-muted">{t('osp.deps')}</h3>
      <ul>{list.map((d) => <DependencyRow key={d.id} d={d} />)}</ul>
    </section>
  );
}

/** For what is still missing later: nothing goes to Claude before the button. */
function SetupDialog({ row, onClose }: { row: OsPluginRow; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!row.setup) return;
    setBusy(true);
    await runSetup(row.setup, row.id);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('osp.setupTitle', { name: row.name })} description={t('osp.setupHint')} width={640}>
      <div className="flex flex-col gap-3">
        <Dependencies list={row.dependencies} />
        {row.setup && <SetupPrompt setup={row.setup} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted"><ClaudeMark size={12} />{spendNote()}</span>
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy || !row.setup} onClick={send}>{t('osp.setupSend')}</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
const ACTION: Record<OsPluginChange['action'], Key> = { add: 'osp.actionAdd', remove: 'osp.actionRemove', keep: 'osp.actionKeep', gone: 'osp.actionGone' };

function writePlugin(dir: string) {
  askClaude({
    subject: {
      kind: 'Claude OS plugin',
      name: 'new plugin',
      context: [
        `Write it as a new folder ${dir}/<id>/, following the plugin format in root/reference/plugins.md of Claude OS.`,
        'Only create files in that folder: do not install anything into Claude, do not enable the plugin. The user reviews and enables it on the Claude OS plugins screen.',
      ].join('\n'),
    },
    title: t('osp.write'),
    placeholder: t('osp.writePlaceholder'),
  });
}

const contextOf = (p: OsPluginRow) => [
  `Folder: ${p.path}`,
  `Source: ${p.source}`,
  p.source === 'shipped' ? `Shipped plugins are not edited in place: copy the folder to config/plugins/${p.id} under the same id and change the copy.` : '',
  `Version: ${p.version ?? 'unknown'}; ${p.enabled ? `enabled, installed version ${p.installedVersion}` : 'not enabled'}.`,
  `Contains: ${JSON.stringify(p.contains)}`,
  p.dependencies.length ? `Dependencies: ${JSON.stringify(p.dependencies.map((d) => ({ id: d.id, kind: d.kind, target: d.target, state: d.state })))}` : '',
  p.errors.length ? `Manifest errors: ${p.errors.join('; ')}` : '',
].filter(Boolean).join('\n');

function Contents({ p }: { p: OsPluginRow }) {
  const parts = [
    { icon: Sparkles, n: p.contains.skills.length, label: t('osp.kindSkill') },
    { icon: Webhook, n: p.contains.hooks.length, label: t('osp.kindHook') },
    { icon: Plug, n: p.contains.mcp.length, label: t('osp.kindMcp') },
    { icon: PanelTop, n: p.contains.ui ? 1 : 0, label: t('osp.kindUi') },
    { icon: LayoutTemplate, n: p.contains.kit ? 1 : 0, label: t('osp.kindKit') },
  ];
  return (
    <span className="flex items-center gap-2.5">
      {parts.filter((x) => x.n > 0).map((x) => <span key={x.label} title={x.label} className="inline-flex items-center gap-1 text-[11px] text-muted"><x.icon size={11} className="text-dim" />{x.n}</span>)}
    </span>
  );
}

function ChangeRow({ c }: { c: OsPluginChange }) {
  const kind = KIND[c.kind];
  return (
    <li className="border-b border-line2 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <kind.icon size={12} className="flex-none text-dim" />
        <span className="text-soft">{c.name}</span>
        <Tag tone={c.action === 'add' ? 'ok' : c.action === 'remove' ? 'accent' : undefined}>{t(ACTION[c.action])}</Tag>
        <span className="text-[11px] text-dim">{t(kind.label)}</span>
      </div>
      <div className="selectable mt-0.5 font-mono text-[11px] wrap-anywhere text-muted">{c.where}</div>
      {c.detail && <div className="selectable mt-0.5 font-mono text-[11px] wrap-anywhere text-soft">{c.detail}</div>}
    </li>
  );
}

/** Asks the server what will change, shows it, and sends back the hash of what was shown. */
function PlanDialog({ row, action, onClose }: { row: OsPluginRow; action: OsPluginPlan['action']; onClose: () => void }) {
  const verbs = VERBS[action];
  const [plan, setPlan] = useState<OsPluginPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupNow, setSetupNow] = useState(true);
  const setup = plan?.setup ?? null;

  useEffect(() => {
    api<OsPluginPlan>(`${PATH}/${encodeURIComponent(row.id)}/preview`, { method: 'POST', body: { action } }).then(setPlan, (e) => {
      toastError(e);
      onClose();
    });
  }, [row.id, action]);

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const next = await api<OsPluginsReport>(`${PATH}/${encodeURIComponent(row.id)}/${action}`, { method: 'POST', body: { confirmed: true, sha: plan.sha } });
      setCached<OsPluginsReport>(PATH, () => next);
      toast(t(verbs.done, { name: row.name }));
      onClose();
      if (setup && setupNow) await runSetup(setup, row.id);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t(verbs.title, { name: row.name })} description={t(verbs.hint)} width={640}>
      {!plan ? <Skeleton lines={4} /> : (
        <div className="flex flex-col gap-3">
          {plan.changes.length > 0 && <ul>{plan.changes.map((c) => <ChangeRow key={`${c.kind}|${c.name}|${c.action}`} c={c} />)}</ul>}
          {action !== 'disable' && plan.changes.some((c) => c.kind === 'ui') && <p className="text-xs text-warn">{t('osp.uiWarning')}</p>}
          {plan.dependencies.length > 0 && <Dependencies list={plan.dependencies} />}
          {setup && (
            <div className="flex flex-col gap-2 rounded-md border border-line p-2.5">
              {plan.dependencies.some((d) => d.state === 'missing' && d.level === 'required') && <p role="alert" className="text-xs text-warn">{t('osp.depUrge')}</p>}
              <Checkbox checked={setupNow} onChange={setSetupNow}>{t('osp.setupNow')}</Checkbox>
              {setupNow ? <SetupPrompt setup={setup} /> : <p className="enter-fade text-xs text-warn">{t('osp.depSkipped')}</p>}
              {setupNow && <span className="flex items-center gap-1.5 text-xs text-muted"><ClaudeMark size={12} />{spendNote()}</span>}
            </div>
          )}
          {plan.conflicts.length > 0 && (
            <div role="alert" className="rounded-md border border-line p-2.5 text-xs text-warn">
              <div className="mb-1 font-medium">{t('osp.conflicts')}</div>
              {plan.conflicts.map((c) => <div key={c} className="wrap-anywhere">{c}</div>)}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant={action === 'disable' ? 'danger' : 'primary'} disabled={busy || plan.conflicts.length > 0} onClick={confirm}>{t(setup && setupNow ? verbs.withSetup : verbs.button)}</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

type Review = (p: OsPluginRow, action: OsPluginPlan['action'] | 'setup') => void;

function rowItems(p: OsPluginRow, review: Review): MenuItem[] {
  return [
    { id: 'osp.page', label: t('osp.open'), icon: ExternalLink, onSelect: () => useApp.getState().go({ kind: 'entity', type: 'os-plugin', id: p.id }) },
    ...(updatable(p) ? [{ id: 'osp.update', label: t('osp.update'), icon: RefreshCw, onSelect: () => review(p, 'update') }] : []),
    ...(p.setup ? [{ id: 'osp.setup', label: t('osp.setup'), icon: Settings2, onSelect: () => review(p, 'setup') }] : []),
    p.enabled
      ? { id: 'osp.toggle', label: t('osp.disable'), icon: PowerOff, onSelect: () => review(p, 'disable') }
      : { id: 'osp.toggle', label: t('osp.enable'), icon: Power, disabled: p.errors.length > 0, onSelect: () => review(p, 'enable') },
    { id: 'osp.path', label: t('osp.copyPath'), icon: ClipboardCopy, title: p.path, onSelect: () => void navigator.clipboard.writeText(p.path).then(() => toast(t('projects.pathCopied')), toastError) },
    ...claudeItems({ kind: 'Claude OS plugin', name: p.name, context: contextOf(p) }).map((item, i) => ({ ...item, apart: i === 0 })),
  ];
}

function States({ p }: { p: OsPluginRow }) {
  return (
    <>
      {p.errors.length > 0 ? <Tag tone="bad">{t('osp.invalid')}</Tag> : p.enabled ? <Tag tone="ok">{t('adm.pluginOn')}</Tag> : <Tag>{t('adm.pluginOff')}</Tag>}
      {p.enabled && p.installedVersion !== p.version && p.version && <Tag tone="accent">{t('osp.newVersion', { v: p.version })}</Tag>}
      {p.changed && <Tag tone="accent" title={t('osp.changedHint')}>{t('osp.changed')}</Tag>}
      {p.enabled && p.setup && <Tag tone="warn">{t('osp.notSet')}</Tag>}
    </>
  );
}

function PluginRow({ p, review }: { p: OsPluginRow; review: Review }) {
  const open = () => useApp.getState().go({ kind: 'entity', type: 'os-plugin', id: p.id });
  return (
    <ContextArea items={rowItems(p, review)} className="grid grid-cols-[auto_minmax(0,1.6fr)_minmax(0,1fr)_90px_auto] items-center gap-4 border-b border-line2 px-5 py-2.5 transition-colors duration-150 hover:bg-white/[.02]">
      <PluginIcon p={p} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button type="button" className="press truncate text-soft hover:text-fg" onClick={open}>{p.name}</button>
          {p.version && <span className="flex-none font-mono text-[11px] text-dim">{p.version}</span>}
        </div>
        <div className="truncate text-[11px] text-dim" title={said(p.description, p.descriptionRu) ?? undefined}>{said(p.description, p.descriptionRu)}</div>
        {p.errors.map((e) => <div key={e} className="text-[11px] wrap-anywhere text-bad">{e}</div>)}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1"><States p={p} /></div>
      <Contents p={p} />
      <div className="flex items-center justify-end gap-1.5">
        {p.enabled && p.setup && !updatable(p) && <Button size="sm" title={spendNote()} onClick={() => review(p, 'setup')}><ClaudeMark size={12} />{t('osp.setup')}</Button>}
        {updatable(p)
          ? <Button size="sm" variant="primary" onClick={() => review(p, 'update')}>{t('osp.update')}</Button>
          : p.enabled
            ? <Button size="sm" onClick={() => review(p, 'disable')}>{t('osp.disable')}</Button>
            : <Button size="sm" disabled={p.errors.length > 0} onClick={() => review(p, 'enable')}>{t('osp.enable')}</Button>}
      </div>
    </ContextArea>
  );
}

function useReview() {
  const [state, setState] = useState<{ row: OsPluginRow; action: OsPluginPlan['action'] | 'setup' } | null>(null);
  const review: Review = (row, action) => setState({ row, action });
  const close = () => setState(null);
  const dialog = !state ? null : state.action === 'setup'
    ? <SetupDialog row={state.row} onClose={close} />
    : <PlanDialog row={state.row} action={state.action} onClose={close} />;
  return { review, dialog };
}

export function OsPluginsPane() {
  const q = useApi<OsPluginsReport>(PATH, ['osPlugins']);
  const { review, dialog } = useReview();

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Boundary query={q} errorClassName="m-5" skeleton={<Skeleton className="p-5" lines={6} />}>
        {(r) => (
          <ContextArea items={[{ id: 'osp.write', label: t('osp.write'), icon: PackagePlus, onSelect: () => writePlugin(r.dir) }]} className="flex min-h-full flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-5 py-2.5">
              <p className="min-w-0 flex-1 text-xs text-muted">{t('osp.hint')}</p>
              <Button size="sm" title={spendNote()} onClick={() => writePlugin(r.dir)}><ClaudeMark size={12} />{t('osp.write')}</Button>
            </div>
            {r.rows.length === 0 && <Empty className="m-5" icon={Package}>{t('osp.empty')}</Empty>}
            {r.rows.map((p) => <PluginRow key={p.id} p={p} review={review} />)}
          </ContextArea>
        )}
      </Boundary>
      {dialog}
    </div>
  );
}

/** Its own screen, apart from Tools: these change Claude OS itself, the panes there show what Claude has. */
export function OsPluginsView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-line2 px-5 py-2">
        <Breadcrumbs className="-ml-1" items={[{ label: t('nav.home'), view: { kind: 'home' } }, { label: t('tools.osPlugins') }]} />
        <h1 className="mt-1 flex items-center gap-2 text-sm font-medium"><Boxes size={15} className="text-dim" />{t('tools.osPlugins')}</h1>
      </div>
      <OsPluginsPane />
    </div>
  );
}

/** The page of one plugin: everything its manifest says and what enabling it would touch. */
export default function OsPluginPage(props: EntityPageProps) {
  const q = useApi<OsPluginsReport>(PATH, ['osPlugins']);
  const { review, dialog } = useReview();
  const p = q.data?.rows.find((x) => x.id === props.id);
  if (!p) return <EntityShell {...props}>{q.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={4} />}</EntityShell>;
  const features = featuresOf(p);
  return (
    <EntityShell
      {...props}
      title={p.name}
      context={contextOf(p)}
      actions={(
        <div className="flex flex-none gap-2">
          {p.setup && <Button title={spendNote()} onClick={() => review(p, 'setup')}><ClaudeMark size={12} />{t('osp.setup')}</Button>}
          {updatable(p) && <Button variant="primary" onClick={() => review(p, 'update')}>{t('osp.update')}</Button>}
          {p.enabled ? <Button onClick={() => review(p, 'disable')}>{t('osp.disable')}</Button> : <Button variant="primary" disabled={p.errors.length > 0} onClick={() => review(p, 'enable')}>{t('osp.enable')}</Button>}
        </div>
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <PluginIcon p={p} size={44} />
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5"><States p={p} /></div>
          {p.description && <p className="text-soft">{said(p.description, p.descriptionRu)}</p>}
        </div>
      </div>
      {p.errors.map((e) => <p key={e} className="mb-1 text-xs wrap-anywhere text-bad">{e}</p>)}
      {features.length > 0 && (
        <section aria-label={t('osp.features')} className="mb-4">
          <h2 className="mb-1 text-[11.5px] font-medium text-muted">{t('osp.features')}</h2>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-soft">{features.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {p.dependencies.length > 0 && <div className="mb-4 text-xs"><Dependencies list={p.dependencies} /></div>}
      <dl className="mb-4 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{t('osp.version')}</dt><dd className="font-mono text-soft">{p.version ?? '–'}</dd>
        <dt className="text-muted">{t('osp.installed')}</dt><dd className="font-mono text-soft">{p.installedVersion ? `${p.installedVersion}${p.installedAt ? ` · ${fmtAgo(p.installedAt)}` : ''}` : '–'}</dd>
        <dt className="text-muted">{t('osp.author')}</dt><dd className="text-soft">{p.author ?? '–'}</dd>
        <dt className="text-muted">{t('osp.folder')}</dt><dd className="selectable font-mono wrap-anywhere text-soft">{p.path}</dd>
      </dl>
      <ul className="text-xs">
        {p.contains.skills.map((s) => <li key={s} className="flex items-center gap-2 border-t border-line2 py-1.5"><Sparkles size={12} className="text-dim" /><span className="text-soft">{s}</span></li>)}
        {p.contains.hooks.map((h) => <li key={`${h.event}|${h.command}`} className="flex items-center gap-2 border-t border-line2 py-1.5"><Webhook size={12} className="flex-none text-dim" /><span className="flex-none text-soft">{h.event}{h.matcher ? ` · ${h.matcher}` : ''}</span><code className="selectable font-mono wrap-anywhere text-muted">{h.command}</code></li>)}
        {p.contains.mcp.map((m) => <li key={m.name} className="flex items-center gap-2 border-t border-line2 py-1.5"><Plug size={12} className="flex-none text-dim" /><span className="flex-none text-soft">{m.name}</span><code className="selectable font-mono wrap-anywhere text-muted">{m.summary}</code></li>)}
        {p.contains.ui && <li className="flex items-center gap-2 border-t border-line2 py-1.5"><PanelTop size={12} className="flex-none text-dim" /><span className="flex-none text-soft">{t('osp.kindUi')}</span><code className="selectable font-mono wrap-anywhere text-muted">{[p.contains.ui.entry, ...p.contains.ui.permissions].join(', ')}</code></li>}
        {p.contains.kit && <li className="flex items-center gap-2 border-t border-line2 py-1.5"><LayoutTemplate size={12} className="flex-none text-dim" /><span className="flex-none text-soft">{t('osp.kindKit')}</span><code className="selectable font-mono wrap-anywhere text-muted">{p.contains.kit}/</code></li>}
      </ul>
      {dialog}
    </EntityShell>
  );
}
