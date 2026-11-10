import { ExternalLink, FileText, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Diff } from '@/components/Diff';
import { Markdown } from '@/components/Markdown';
import { Boundary, Empty, ErrorState } from '@/components/states';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Button, Dialog, Segmented, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtAgo, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toast, toastError } from '@/lib/store';
import type { ClaudeMdFile, ClaudeMdReport, Project } from '@/lib/types';
import { AskClaude } from './admin/parts';

const LEVEL = {
  global: { where: 'md.whereGlobal', when: 'md.whenGlobal', change: 'md.changeGlobal' },
  root: { where: 'md.whereRoot', when: 'md.whenRoot', change: 'md.changeRoot' },
  project: { where: 'md.whereProject', when: 'md.whenProject', change: 'md.changeProject' },
} as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-[11px] text-dim">{label}</dt>
      <dd className="text-xs leading-[1.5] text-muted">{children}</dd>
    </div>
  );
}

function SaveDialog({ f, project, text, onClose, onSaved }: { f: ClaudeMdFile; project: string | null; text: string; onClose: () => void; onSaved: () => void }) {
  const body = { scope: f.scope, project: project ?? undefined, content: text };
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useState(() => {
    api<{ diff: string }>('/api/claude-md/preview', { method: 'POST', body }).then((r) => setDiff(r.diff), (e: Error) => setError(e.message));
    return null;
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={shortPath(f.path)} description={t('skills.backupNote')} width={720}>
      {error && <ErrorState message={error} className="mb-3" />}
      {diff !== null && <Diff diff={diff} maxHeight={440} />}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={diff === null || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/claude-md', { method: 'PUT', body: { ...body, version: f.version } });
              toast(t('skills.saved'));
              onSaved();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {t('skills.write')}
        </Button>
      </div>
    </Dialog>
  );
}

function FileView({ f, project, onChanged, levelName }: { f: ClaudeMdFile; project: string | null; onChanged: () => void; levelName: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const level = LEVEL[f.scope];
  const open = () => api('/api/claude-md/open', { method: 'POST', body: { scope: f.scope, project: project ?? undefined } }).catch(toastError);
  return (
    <>
      <dl className="grid gap-x-8 gap-y-3 border-b border-line2 px-5 py-4 app:grid-cols-3">
        <Fact label={t('md.where')}>{t(level.where)}</Fact>
        <Fact label={t('md.when')}>{t(level.when)}</Fact>
        <Fact label={t('md.change')}>{t(level.change)}</Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-b border-line2 px-5 py-2">
        <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim" title={f.path}>
          {shortPath(f.path)}{f.updatedAt ? ` · ${t('md.changed', { ago: fmtAgo(f.updatedAt) })}` : ''}
        </code>
        {draft === null ? (
          <>
            {f.exists && <Button onClick={open}><ExternalLink size={12} />{t('md.openIde')}</Button>}
            <Button onClick={() => setDraft(f.content)}><Pencil size={12} />{f.exists ? t('md.edit') : t('md.create')}</Button>
          </>
        ) : (
          <>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={draft === f.content} onClick={() => setSaving(true)}>{t('skills.save')}</Button>
          </>
        )}
        <AskClaude task="admin-claude-md" vars={{ path: f.path, level: levelName }} project={f.scope === 'project' ? project : undefined} />
      </div>
      {draft !== null ? (
        <Textarea aria-label="CLAUDE.md" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} className="min-h-[60vh] rounded-none border-0 bg-black/30 px-5 py-4 font-mono text-[12.5px] leading-[1.6]" />
      ) : f.exists && f.content.trim() ? (
        <div className="max-w-4xl px-5 py-4"><Markdown text={f.content} small /></div>
      ) : (
        <Empty className="m-5" icon={FileText}>{t('md.missing', { path: shortPath(f.path) })}</Empty>
      )}
      {saving && draft !== null && (
        <SaveDialog f={f} project={project} text={draft} onClose={() => setSaving(false)} onSaved={() => { setSaving(false); setDraft(null); onChanged(); }} />
      )}
    </>
  );
}

export function ClaudeMdPane() {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const [project, setProject] = useState<string | null>(null);
  const [scope, setScope] = useState<ClaudeMdFile['scope']>('global');
  const list = (projects.data ?? []).filter((p) => !p.misc);
  const key = project ?? list[0]?.key ?? null;
  const q = useApi<ClaudeMdReport>(`/api/claude-md${key ? `?project=${encodeURIComponent(key)}` : ''}`);
  const names = { global: t('md.global'), root: t('md.root'), project: t('md.project') };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sheet-bar sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-3 border-b border-line2 px-5 py-2">
        <Segmented ariaLabel={t('md.fileAria')} value={scope} onChange={setScope} options={[{ value: 'global', label: names.global }, { value: 'root', label: names.root }, { value: 'project', label: names.project }]} />
        {scope === 'project' && <ProjectSelect className="w-56 text-xs" ariaLabel={t('md.project')} value={key} onChange={setProject} projects={list} />}
      </div>
      <p className="border-b border-line2 px-5 py-3 text-xs leading-[1.55] text-muted">{t('md.what')}</p>
      <Boundary query={q}>
        {(r) => {
          const f = r.files.find((x) => x.scope === scope);
          return f ? <FileView key={f.path} f={f} project={key} onChanged={q.refetch} levelName={names[scope]} /> : <Empty className="m-5">{t('md.noProject')}</Empty>;
        }}
      </Boundary>
    </div>
  );
}
