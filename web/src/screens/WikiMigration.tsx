// Per-project wiki migration (spec §4): start, the batches in their tabs, the preview, apply and undo.
// Every step is an explicit button: nothing starts, applies or undoes by itself.
import { Ellipsis, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Diff } from '@/components/Diff';
import { ErrorState } from '@/components/states';
import { Button, Checkbox, Dialog, IconButton } from '@/components/ui';
import { ActionMenu, type MenuItem } from '@/home/ActionMenu';
import { api, setCached, useApi } from '@/lib/api';
import { cn, fmtInt } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { toast, useApp } from '@/lib/store';
import type { WikiPreview, WikiRunView, WikiSize } from '@/lib/types';
import { Tag } from './admin/parts';

type Run = WikiRunView | null;
type Undo = { restored: string[]; kept: string[]; conflicts: string[] };
type Batch = WikiRunView['batches'][number];

const runPath = (key: string) => `/api/memory/wiki/${encodeURIComponent(key)}`;
const useRun = (key: string | null) => useApi<Run>(key && runPath(key), ['memory']);
const doneOf = (r: WikiRunView) => r.batches.filter((b) => b.status === 'ok').length;

function stateLabel(r: Run): string {
  if (r?.state === 'rewriting') return t('memory.wiki.state.rewriting', { done: doneOf(r), total: r.batches.length });
  if (r?.state === 'ready') return t('memory.wiki.state.ready');
  if (r?.state === 'failed') return t('memory.wiki.state.failed');
  if (r?.state === 'applied') return t('memory.wiki.state.applied');
  return t('memory.wiki.migrate');
}

const stateTone: Partial<Record<WikiRunView['state'], string>> = { rewriting: 'text-accent!', ready: 'text-accent!', failed: 'text-bad!', applied: 'text-ok!' }; // over the ghost button's own colour

/** The row's action in the format list: what the run is at, one click to its dialog. */
export function MigrateCell({ project, onOpen }: { project: string; onOpen: () => void }) {
  const q = useRun(project);
  if (q.data === undefined) return null; // no label flips from "Migrate" to the run's state
  const run = q.data;
  return (
    <Button size="sm" variant="ghost" className={cn('-my-0.5', run && stateTone[run.state])} onClick={onOpen}>
      {stateLabel(run)}
    </Button>
  );
}

const batchTone: Record<Batch['status'], 'accent' | 'ok' | 'bad' | undefined> = { pending: undefined, running: 'accent', ok: 'ok', failed: 'bad' };

function Batches({ batches, onTab }: { batches: Batch[]; onTab: (id: string) => void }) {
  return (
    <ul aria-label={t('memory.wiki.batches')} className="flex flex-col divide-y divide-line2 rounded-md border border-line2">
      {batches.map((b) => (
        <li key={b.n} className="px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="flex-none text-soft">{t('memory.wiki.batch', { n: b.n })}</span>
            <Tag tone={batchTone[b.status]}>{t(`memory.wiki.batch.${b.status}`)}</Tag>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim" title={b.files.join('\n')}>{b.files.join(', ')}</span>
            {b.tabId && <Button size="sm" variant="ghost" onClick={() => onTab(b.tabId!)}>{t('memory.wiki.openTab')}</Button>}
          </div>
          {b.errors.length > 0 && (
            <ul className="selectable mt-1.5 flex flex-col gap-0.5 font-mono text-[11px] text-bad">
              {b.errors.map((e, i) => <li key={i} className="wrap-anywhere">{e}</li>)}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function SizeRow({ label, s }: { label: string; s: WikiSize }) {
  return (
    <tr className="border-t border-line2">
      <td className="py-1 text-muted">{label}</td>
      <td className="py-1 text-right text-soft">{fmtInt(s.lines)}</td>
      <td className="py-1 text-right text-soft">{fmtInt(s.bytes)}</td>
      <td className="py-1 text-right text-soft">{fmtInt(s.tokens)}</td>
    </tr>
  );
}

function Sizes({ memory }: { memory: WikiPreview['memory'] }) {
  return (
    <table aria-label={t('memory.wiki.sizes')} className="w-full max-w-md table-fixed text-xs">
      <thead className="text-[11px] text-dim">
        <tr>
          <th className="py-1 text-left font-mono font-normal">MEMORY.md</th>
          <th className="py-1 text-right font-normal">{t('memory.wiki.lines')}</th>
          <th className="py-1 text-right font-normal">{t('memory.wiki.bytes')}</th>
          <th className="py-1 text-right font-normal" title={t('memory.wiki.tokensHint')}>{t('memory.wiki.tokens')}</th>
        </tr>
      </thead>
      <tbody>
        <SizeRow label={t('memory.wiki.before')} s={memory.before} />
        <SizeRow label={t('memory.wiki.after')} s={memory.after} />
      </tbody>
    </table>
  );
}

function FileMap({ files }: { files: WikiPreview['files'] }) {
  return (
    <ul aria-label={t('memory.wiki.files')} className="selectable flex max-h-72 flex-col divide-y divide-line2 overflow-auto rounded-md border border-line2 text-xs">
      {files.map((f) => (
        <li key={f.old} className="px-3 py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-muted">{f.old}</span>
            <span className="text-dim">→</span>
            {f.new.length === 0 ? <span className="text-dim">{t('memory.wiki.noNew')}</span> : f.new.map((n) => <span key={n} className="font-mono text-soft">{n}</span>)}
          </div>
          {f.dropped.map((d, i) => (
            <div key={i} className="mt-0.5 pl-3 text-dim">
              {t('memory.wiki.dropped')}: <span className="text-muted">{d.what}</span> — {d.why}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{title}</div>
      {children}
    </div>
  );
}

function Warnings({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <Section title={t('memory.wiki.warnings')}>
      <ul className="selectable flex max-h-36 flex-col gap-0.5 overflow-auto text-xs text-warn">
        {list.map((w, i) => <li key={i} className="wrap-anywhere">{w}</li>)}
      </ul>
    </Section>
  );
}

function Preview({ p }: { p: WikiPreview }) {
  const linked = p.linkDiff.split('\n').filter((l) => l.startsWith('+++ ')).length;
  if (p.files.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-[1.55] text-muted">{t('memory.wiki.emptyProject')}</p>
        <Warnings list={p.warnings} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-soft">{fmtInt(p.files.length)} {tn('unit.file', p.files.length)} → {fmtInt(p.notesAfter)} {tn('unit.note', p.notesAfter)}</p>
      <Sizes memory={p.memory} />
      <Section title={t('memory.wiki.files')}><FileMap files={p.files} /></Section>
      <Warnings list={p.warnings} />
      {linked > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted select-none hover:text-fg">{t('memory.wiki.links', { n: fmtInt(linked), unit: tn('unit.file', linked) })}</summary>
          <div className="mt-1.5"><Diff diff={p.linkDiff} maxHeight={240} /></div>
        </details>
      )}
    </div>
  );
}

function UndoResult({ r }: { r: Undo }) {
  const list = (label: string, files: string[]) => files.length > 0 && (
    <Section title={label}>
      <ul aria-label={label} className="selectable font-mono text-[11.5px] text-soft">{files.map((f) => <li key={f}>{f}</li>)}</ul>
    </Section>
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line2 px-3 py-2 text-xs">
      <div className="text-soft">{t('memory.wiki.restored', { n: fmtInt(r.restored.length) })}</div>
      {list(t('memory.wiki.kept'), r.kept)}
      {list(t('memory.wiki.conflicts'), r.conflicts)}
    </div>
  );
}

function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <ActionMenu label={t('memory.wiki.more')} items={items} open={open} onOpenChange={setOpen} side="bottom" align="start"
      trigger={<IconButton label={t('memory.wiki.more')}><Ellipsis size={14} /></IconButton>} />
  );
}

/** One request at a time; a run it returns replaces the cached one at once, the server's invalidation follows. */
function useActions(project: string, name: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const call = async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await api<T>(runPath(project) + path, { method, body });
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const step = async (path: string, body?: unknown) => {
    const r = await call<WikiRunView>(path, 'POST', body);
    if (r) setCached<Run>(runPath(project), () => r);
    return r;
  };
  return {
    busy, error, undo, confirming,
    askDiscard: () => setConfirming(true),
    cancelDiscard: () => setConfirming(false),
    start: () => { setUndo(null); void step('/prepare'); },
    verify: () => void step('/verify'),
    apply: async (connect: boolean) => { if (await step('/apply', { connect })) toast(t('memory.wiki.appliedToast', { name })); },
    discard: async () => {
      if (await call('', 'DELETE')) setCached<Run>(runPath(project), () => null);
      setConfirming(false);
    },
    undoRun: async () => {
      const r = await call<Undo>('/undo', 'POST');
      if (r) { setUndo(r); toast(t('memory.wiki.undoneToast', { name })); }
    },
  };
}

function Footer({ more, children }: { more: MenuItem[]; children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-2">
      {more.length > 0 && <MoreMenu items={more} />}
      <span className="flex-1" />
      {children}
    </div>
  );
}

type Actions = ReturnType<typeof useActions>;
const verifyItem = (a: Actions): MenuItem => ({ id: 'wiki.verify', label: t('memory.wiki.verify'), icon: RefreshCw, disabled: a.busy, onSelect: a.verify });
const discardItem = (a: Actions): MenuItem => ({ id: 'wiki.discard', label: t('memory.wiki.discard'), icon: Trash2, danger: true, disabled: a.busy, onSelect: a.askDiscard });

/** Discard drops the batch outputs Claude wrote: asked once more, as every removal is. */
function ConfirmDiscard({ a, name }: { a: Actions; name: string }) {
  return (
    <Dialog open={a.confirming} onOpenChange={(o) => !o && a.cancelDiscard()} title={t('memory.wiki.discardTitle', { name })} description={t('memory.wiki.discardDesc')}>
      <div className="flex justify-end gap-2">
        <Button onClick={a.cancelDiscard}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={a.busy} onClick={() => void a.discard()}>{t('memory.wiki.discardConfirm')}</Button>
      </div>
    </Dialog>
  );
}

function Ready({ p, a }: { p: WikiPreview; a: Actions }) {
  const [connect, setConnect] = useState(true);
  return (
    <>
      <Preview p={p} />
      <div className="mt-3"><Checkbox checked={connect} onChange={setConnect}><span className="text-xs">{t('memory.wiki.connect')}</span></Checkbox></div>
      <p className="mt-0.5 pl-5.5 text-[11px] text-dim">{t('memory.wiki.connectHint')}</p>
      <Footer more={[verifyItem(a), discardItem(a)]}>
        <Button variant="primary" disabled={a.busy} onClick={() => void a.apply(connect)}>{t('memory.wiki.apply')}</Button>
      </Footer>
    </>
  );
}

function Rewriting({ run, a, onTab }: { run: WikiRunView; a: Actions; onTab: (id: string) => void }) {
  return (
    <>
      <p className="mb-3 text-xs leading-[1.55] text-muted">{t(run.state === 'failed' ? 'memory.wiki.failedHint' : 'memory.wiki.rewritingHint')}</p>
      <Batches batches={run.batches} onTab={onTab} />
      <Footer more={[discardItem(a)]}>
        <Button disabled={a.busy} onClick={a.verify}>{t('memory.wiki.verify')}</Button>
      </Footer>
    </>
  );
}

function Applied({ run, a }: { run: WikiRunView; a: Actions }) {
  return (
    <>
      <p className="text-xs leading-[1.55] text-muted">{t('memory.wiki.applied')}</p>
      {run.preview && run.preview.files.length > 0 && <div className="mt-3"><Sizes memory={run.preview.memory} /></div>}
      <Footer more={[]}><Button disabled={a.busy} onClick={() => void a.undoRun()}>{t('memory.wiki.undo')}</Button></Footer>
    </>
  );
}

/** No run, or an undone one: what a migration does, and Start. */
function Start({ undone, a }: { undone: boolean; a: Actions }) {
  return (
    <>
      {a.undo ? <UndoResult r={a.undo} /> : undone && <p className="mb-2 text-xs text-dim">{t('memory.wiki.undoneBefore')}</p>}
      <p className={cn('text-xs leading-[1.55] text-muted', a.undo && 'mt-3')}>{t('memory.wiki.intro')}</p>
      <Footer more={[]}><Button variant="primary" disabled={a.busy} onClick={a.start}>{t('memory.wiki.start')}</Button></Footer>
    </>
  );
}

function Body({ run, a, onTab }: { run: Run; a: Actions; onTab: (id: string) => void }) {
  if (run?.state === 'ready' && run.preview) return <Ready p={run.preview} a={a} />;
  if (run?.state === 'applied') return <Applied run={run} a={a} />;
  if (!run || run.state === 'undone') return <Start undone={!!run} a={a} />;
  return <Rewriting run={run} a={a} onTab={onTab} />;
}

function Content({ project, name, onClose }: { project: string; name: string; onClose: () => void }) {
  const q = useRun(project);
  const a = useActions(project, name);
  const onTab = (id: string) => {
    onClose();
    useApp.getState().go({ kind: 'tab', id });
  };
  if (q.data === undefined) return q.error ? <ErrorState message={q.error} onRetry={q.refetch} /> : null;
  return (
    <div key={q.data?.state ?? 'none'} className="enter-fade">
      {a.error && <ErrorState message={a.error} className="mb-3 whitespace-pre-wrap" />}
      <Body run={q.data} a={a} onTab={onTab} />
      <ConfirmDiscard a={a} name={name} />
    </div>
  );
}

/** The migration of one project in a dialog that follows the run's state. */
export function WikiMigration({ project, name, onClose }: { project: string | null; name: string; onClose: () => void }) {
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()} title={t('memory.wiki.title', { name })} width={720}>
      {project && <Content project={project} name={name} onClose={onClose} />}
    </Dialog>
  );
}
