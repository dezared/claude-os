import { spendNote } from '@/lib/account';
import { ArrowUpRight, FileJson, Pencil, Plug, ScanSearch, Sparkles, Webhook } from 'lucide-react';
import { useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea } from '@/components/ContextMenu';
import { Diff } from '@/components/Diff';
import { Boundary, Empty, ErrorState, Skeleton } from '@/components/states';
import { Button, Dialog, IconButton, SectionTitle, Textarea } from '@/components/ui';
import { api, invalidateTopics, useApi } from '@/lib/api';
import { shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { toast, useApp } from '@/lib/store';
import { KitStatusRow } from './KitStatusRow';
import type { ProjectSetup, PromotePreview, PromoteRequest, SetupFile } from '@/lib/types';
import { skillMenu } from '@/screens/admin/menus';

function Origin({ children }: { children: string }) {
  return <span className="flex-none rounded bg-white/[.07] px-1.5 text-[10.5px] leading-[1.6] text-dim">{children}</span>;
}

function EditSettings({ project, file, onClose, onSaved }: { project: string; file: SetupFile; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(file.text);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(project)}/setup`;

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      setDiff((await api<{ diff: string }>(`${base}/preview`, { method: 'POST', body: { scope: file.scope, text } })).diff);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api(`${base}/${file.scope}`, { method: 'PUT', body: { text } });
      toast(t('setup.saved'));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={shortPath(file.path)} description={t('setup.editHint')} width={760}>
      <div className="flex flex-col gap-3">
        {error && <ErrorState message={error} />}
        {diff === null ? (
          <Textarea aria-label={file.path} value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} className="font-mono text-[12px] leading-[1.55]" />
        ) : (
          <Diff diff={diff} maxHeight={420} />
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={diff === null ? onClose : () => setDiff(null)}>{diff === null ? t('common.cancel') : t('setup.back')}</Button>
          {diff === null ? (
            <Button variant="primary" disabled={busy} onClick={preview}>{t('setup.preview')}</Button>
          ) : (
            <Button variant="primary" disabled={busy || !diff} onClick={save}>{t('setup.save')}</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function PromoteDialog({ project, req, onClose, onDone }: { project: string; req: PromoteRequest; onClose: () => void; onDone: () => void }) {
  const [pre, setPre] = useState<PromotePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(project)}/promote`;
  useState(() => {
    api<PromotePreview>(`${base}/preview`, { method: 'POST', body: req }).then(setPre, (e: Error) => setError(e.message));
    return null;
  });
  const confirm = async () => {
    setBusy(true);
    try {
      await api(base, { method: 'POST', body: { ...req, confirmed: true } });
      toast(t('setup.promoted'));
      invalidateTopics(['skills', 'mcp', 'overview']);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('setup.promoteTitle', { name: pre?.title ?? '' })} description={t('setup.promoteHint')} width={720}>
      <div className="flex flex-col gap-3">
        {error && <ErrorState message={error} />}
        {!pre && !error && <Skeleton lines={4} />}
        {pre?.conflict && <ErrorState message={t('setup.conflict', { reason: pre.conflict })} />}
        {pre?.files.map((f) => (
          <div key={f.path}>
            <div className="mb-1 truncate font-mono text-[11px] text-dim" title={f.path}>{shortPath(f.path)}</div>
            <Diff diff={f.diff} maxHeight={220} />
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !pre || !!pre.conflict} onClick={confirm}>{t('setup.promoteAction')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ title, origin, detail, onPromote, onEdit, name }: { title: string; origin: string; detail?: string | null; onPromote?: () => void; onEdit?: () => void; name?: string }) {
  return (
    <div className="group -mx-1 rounded-md px-1 py-1 hover:bg-raised">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-soft" title={title}>{title}</span>
        <Origin>{origin}</Origin>
        <span className="flex w-11 flex-none justify-end">
          {onEdit && <IconButton label={t('setup.edit', { name: name ?? title })} className="size-5.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onEdit}><Pencil size={11} /></IconButton>}
          {onPromote && <IconButton label={t('setup.promote', { name: name ?? title })} className="size-5.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onPromote}><ArrowUpRight size={12} /></IconButton>}
        </span>
      </div>
      {detail && <div className="truncate text-[11px] text-dim" title={detail}>{detail}</div>}
    </div>
  );
}

const scopeLabel = (s: string) => (s === 'local' ? t('setup.local') : t('setup.shared'));

/** The project's own Claude setup. Rendered only when this tab of the side panel is chosen. */
export function ProjectSetupPanel({ project }: { project: string }) {
  const q = useApi<ProjectSetup>(`/api/projects/${encodeURIComponent(project)}/setup`, ['skills', 'mcp']);
  const [edit, setEdit] = useState<SetupFile | null>(null);
  const [promote, setPromote] = useState<PromoteRequest | null>(null);
  const go = useApp.getState().go;

  return (
    <div className="flex flex-col gap-5">
      <Boundary query={q} skeleton={<Skeleton lines={6} />}>
        {(s) => (
          <>
            <div>
              <Button
                className="w-full"
                title={spendNote()}
                onClick={() => runMicrotask({ id: 'project-check', project, title: t('setup.checkTab'), vars: { root: s.root } })}
              >
                <ScanSearch size={13} />{t('setup.check')}<ClaudeMark size={11} />
              </Button>
              <p className="mt-1 text-[11px] leading-[1.4] text-dim">{t('setup.checkHint')}</p>
            </div>
            <KitStatusRow project={project} root={s.root} />

            <section>
              <SectionTitle icon={FileJson}>{t('setup.settings')}</SectionTitle>
              {s.settings.map((f) => (
                <div key={f.scope} className="mb-1.5">
                  <Row title={f.path.split('/').at(-1)!} origin={scopeLabel(f.scope)} detail={f.invalid ? t('setup.invalid') : f.exists ? null : t('setup.noFile')} onEdit={f.invalid ? undefined : () => setEdit(f)} name={f.path.split('/').at(-1)} />
                  {f.keys.filter((k) => k !== 'hooks').map((key) => (
                    <div key={key} className="ml-2 border-l border-line2 pl-2">
                      <Row title={key} origin={scopeLabel(f.scope)} onPromote={() => setPromote({ kind: 'key', scope: f.scope, key })} />
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section>
              <SectionTitle icon={Webhook} aside={s.hooks.length || undefined}>{t('setup.hooks')}</SectionTitle>
              {s.hooks.length === 0 && <Empty>{t('setup.noHooks')}</Empty>}
              {s.hooks.map((h) => (
                <Row key={`${h.scope}${h.event}${h.index}`} title={`${h.event}${h.matcher ? ` · ${h.matcher}` : ''}`} origin={scopeLabel(h.scope)} detail={h.summary} onPromote={() => setPromote({ kind: 'hook', scope: h.scope, event: h.event, index: h.index })} />
              ))}
            </section>

            <section>
              <SectionTitle icon={Plug} aside={s.mcp.length || undefined}>{t('setup.mcp')}</SectionTitle>
              {s.mcp.length === 0 && <Empty>{t('setup.noMcp')}</Empty>}
              {s.mcp.map((m) => (
                <Row key={`${m.scope}${m.name}`} title={m.name} origin={m.scope === 'local' ? t('setup.local') : t('setup.shared')} detail={m.summary} onEdit={() => go({ kind: 'tools', pane: 'mcp' })} onPromote={m.scope === 'project' || m.scope === 'local' ? () => setPromote({ kind: 'mcp', name: m.name, scope: m.scope as 'project' | 'local' }) : undefined} />
              ))}
            </section>

            <section>
              <SectionTitle icon={Sparkles} aside={s.skills.length || undefined}>{t('setup.skills')}</SectionTitle>
              {s.skills.length === 0 && <Empty>{t('setup.noSkills')}</Empty>}
              {s.skills.map((k) => (
                <ContextArea key={k.id} items={() => skillMenu(k)}><Row title={k.name} origin={k.disabled ? t('setup.disabled') : t('setup.shared')} detail={k.description} onEdit={() => go({ kind: 'tools', pane: 'skills' })} onPromote={() => setPromote({ kind: 'skill', name: k.name })} /></ContextArea>
              ))}
            </section>
          </>
        )}
      </Boundary>
      {edit && <EditSettings project={project} file={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.refetch(); }} />}
      {promote && <PromoteDialog project={project} req={promote} onClose={() => setPromote(null)} onDone={() => { setPromote(null); q.refetch(); }} />}
    </div>
  );
}

