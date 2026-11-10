import { CircleAlert, ExternalLink, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, IconButton, Textarea } from '@/components/ui';
import { api, ApiError, invalidateTopics, useApi } from '@/lib/api';
import { fmtAgo, fmtInt, shortPath } from '@/lib/format';
import { has, t, tn } from '@/lib/i18n';
import { toast, toastError, useApp } from '@/lib/store';
import type { MemoryGraph, MemoryNote, SettingsView } from '@/lib/types';
import { MigrateDialog } from './MigrateDialog';
import { NoteUsage } from './NoteUsage';

/** A lint code in words; a code this build does not know shows as is. */
export function issueLabel(code: string): string {
  const key = `memory.issue.${code}`;
  return has(key) ? t(key) : code;
}

const savedMessage = (left: string[]) => (left.length ? t('memory.wiki.savedWithIssues', { list: left.map(issueLabel).join(', ') }) : t('note.saved'));

function NoteIssues({ note }: { note: MemoryNote | undefined }) {
  const codes = note?.node.issues ?? [];
  if (codes.length === 0) return null;
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-line2 px-3 py-2 text-xs">
      <CircleAlert size={12} className="mt-0.5 flex-none text-warn" />
      <ul aria-label={t('memory.wiki.formatIssues')} className="flex flex-wrap gap-x-3 gap-y-1 text-soft">
        {codes.map((c) => <li key={c}>{issueLabel(c)}</li>)}
      </ul>
    </div>
  );
}

function NoteBody({ id }: { id: string }) {
  const note = useApi<MemoryNote>(`/api/memory/notes/${encodeURIComponent(id)}`, ['memory']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const settings = useApi<SettingsView>('/api/settings', ['settings']).data;
  const obsidianMissing = settings?.obsidian.installed === false;
  const openInObsidian = async (url: string) => {
    try {
      await api('/api/settings/obsidian/open', { method: 'POST', body: { url } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast(t('note.obsidianNoVault', { vault: settings?.obsidian.vaultWindows ?? '' }));
      else toastError(e);
    }
  };
  const openNote = useApp((s) => s.openNote);
  const [draft, setDraft] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [migrate, setMigrate] = useState<string | null>(null);

  useEffect(() => {
    setDraft(null);
    setConflict(false);
  }, [id]);

  const editing = draft !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      if (draft !== null) {
        if (note.data && draft !== note.data.markdown) return; // an unsaved draft is never dropped by a key press
        setDraft(null);
      } else {
        openNote(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, note.data, openNote]);

  const save = async (version: string) => {
    if (draft === null) return;
    setSaving(true);
    try {
      const saved = await api<MemoryNote>(`/api/memory/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: { markdown: draft, version } });
      setDraft(null);
      setConflict(false);
      invalidateTopics(['memory']);
      toast(savedMessage(saved.node.issues));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const overwrite = async () => {
    try {
      const fresh = await api<MemoryNote>(`/api/memory/notes/${encodeURIComponent(id)}`);
      await save(fresh.version);
    } catch (e) {
      toastError(e);
    }
  };

  const n = note.data;
  const titleFor = (linkId: string) => graph.data?.nodes.find((x) => x.id === linkId || x.title === linkId || x.file === linkId);

  return (
    <>
      <header className="flex flex-none items-start gap-2 border-b border-line2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[13px] font-medium" title={n?.node.title}>
            {n?.node.title ?? ' '}
          </h2>
          {n && (
            <p className="truncate text-[11px] text-dim" title={n.path}>
              {n.node.project ?? t('note.global')} · {fmtAgo(n.node.mtime)} · {fmtInt(n.node.degree)} {tn('unit.link', n.node.degree)}
            </p>
          )}
          {n && <NoteUsage id={n.node.id} file={n.node.file} />}
        </div>
        <IconButton label={t('note.close')} onClick={() => openNote(null)}>
          <X size={14} />
        </IconButton>
      </header>

      {n && (
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line2 px-4 py-2">
          {!editing && n.node.connected && (
            <Button
              size="sm"
              onClick={() => {
                setDraft(n.markdown);
                setBaseVersion(n.version);
                setConflict(false);
              }}
            >
              <Pencil size={11} /> {t('note.edit')}
            </Button>
          )}
          {editing && (
            <>
              <Button size="sm" variant="primary" disabled={saving || draft === n.markdown} onClick={() => save(baseVersion!)}>
                {t('note.save')}
              </Button>
              <Button size="sm" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
            </>
          )}
          {n.obsidianUrl && !obsidianMissing ? (
            <Button size="sm" onClick={() => void openInObsidian(n.obsidianUrl!)}>
              <ExternalLink size={11} /> {t('note.openObsidian')}
            </Button>
          ) : (
            <Button size="sm" disabled title={obsidianMissing ? t('note.obsidianMissing') : t('note.notInVault')}>
              <ExternalLink size={11} /> {t('note.openObsidian')}
            </Button>
          )}
          {!n.node.connected && n.node.project && (
            <Button size="sm" onClick={() => setMigrate(n.node.project)}>
              {t('note.migrate')}
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!n && !note.error && <Skeleton lines={8} />}
        {!n && note.error && <ErrorState message={note.error} onRetry={note.refetch} />}
        {n && !n.node.connected && !editing && <p className="mb-3 text-xs text-dim">{t('note.readOnly')}</p>}
        {conflict && (
          <div role="alert" className="mb-3 rounded-md border border-accent-deep bg-accent-bg p-3 text-xs text-soft">
            <p className="mb-2">{t('note.conflict')}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={overwrite} disabled={saving}>
                {t('note.overwrite')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setConflict(false);
                  setDraft(null);
                  note.refetch();
                }}
              >
                {t('note.takeDisk')}
              </Button>
            </div>
          </div>
        )}
        <NoteIssues note={n} />
        {n && !conflict && editing && n.version !== baseVersion && (
          <p className="mb-3 text-xs text-accent">{t('note.changedOnDisk')}</p>
        )}
        {n &&
          (editing ? (
            <Textarea
              aria-label={t('note.textAria')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              spellCheck={false}
              className="h-full min-h-80 font-mono text-[12.5px] leading-[1.6]"
            />
          ) : n.markdown.trim() ? (
            <Markdown text={n.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')} small />
          ) : (
            <p className="text-dim">{t('note.empty')}</p>
          ))}
        {n && !editing && n.backlinks.length > 0 && (
          <section className="mt-6 border-t border-line2 pt-3">
            <h3 className="mb-1.5 text-[11px] font-medium text-dim">{t('note.backlinks')}</h3>
            {n.backlinks.map((b) => {
              const target = titleFor(b);
              return target ? (
                <button key={b} type="button" onClick={() => openNote(target.id)} className="press block w-full truncate rounded py-0.5 text-left font-mono text-xs text-muted hover:text-fg">
                  {target.title}
                </button>
              ) : (
                <div key={b} className="truncate py-0.5 font-mono text-xs text-dim">{b}</div>
              );
            })}
          </section>
        )}
        {n && !editing && <p className="selectable mt-6 font-mono text-[11px] wrap-anywhere text-dim">{shortPath(n.path)}</p>}
      </div>
      <MigrateDialog project={migrate} onClose={() => setMigrate(null)} />
    </>
  );
}

export function NotePanel() {
  const id = useApp((s) => s.noteId);
  if (!id) return null;
  return (
    <aside aria-label={t('note.panelAria')} className="note-panel glass-reading absolute inset-y-2 right-2 z-30 flex w-[min(520px,calc(100%-16px))] flex-col overflow-hidden rounded-2xl">
      <NoteBody key={id} id={id} />
    </aside>
  );
}
