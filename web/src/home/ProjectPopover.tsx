import { CircleStop, FileText, Orbit, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { StatusDot } from '@/components/StatusDot';
import { Button, Dialog, IconButton } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtAgo, statusLabel } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { toast, toastError, useApp } from '@/lib/store';
import { createTab } from '@/lib/tabs';
import type { MemoryNode, Project, SessionInfo } from '@/lib/types';
import { projectItems } from './ProjectMenu';

const WIDTH = 340;
const ROOM_ABOVE = 214;
const TITLE_BAR = 52;
const CORE_ROOM_BELOW = 300;
const CORE_NOTES_SHOWN = 4;

function canStop(s: SessionInfo) {
  return s.pid !== null || s.origin === 'os';
}

function SessionRow({ s, onStop }: { s: SessionInfo; onStop: () => void }) {
  const title = s.title ?? s.name ?? s.id;
  const stoppable = canStop(s);
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1.5">
      <StatusDot status={s.status} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg" title={title}>{title}</div>
        <div className="text-[11px] text-muted">
          {statusLabel(s.status)} · {t('project.activity', { ago: fmtAgo(s.lastActivity) })}
        </div>
        {s.lastPrompt && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug wrap-anywhere text-dim">{t('project.lastPrompt', { text: s.lastPrompt })}</div>}
        {!stoppable && <div className="mt-0.5 text-[11px] leading-snug text-dim">{t('project.stopNoPid')}</div>}
      </div>
      <IconButton label={t('project.stop')} disabled={!stoppable} title={stoppable ? t('project.stop') : t('project.stopNoPid')} className="size-6.5" onClick={onStop}>
        <CircleStop size={14} />
      </IconButton>
    </div>
  );
}

/** What the core holds: the same notes that lie around the nucleus. */
function CoreNotes({ notes, onOpen }: { notes: MemoryNode[]; onOpen: () => void }) {
  const openNote = useApp((s) => s.openNote);
  return (
    <div className="mb-1 border-b border-line2 px-2 pb-1.5">
      <div className="mb-0.5 text-[11px] text-muted">{notes.length} {tn('unit.note', notes.length)}</div>
      {notes.slice(0, CORE_NOTES_SHOWN).map((n) => (
        <button
          key={n.id}
          type="button"
          title={n.summary ?? n.title}
          onClick={() => {
            onOpen();
            openNote(n.id);
          }}
          className="press flex w-full items-center gap-1.5 rounded py-0.5 text-left text-[12px] text-soft hover:text-accent-hover"
        >
          <FileText size={11} className="flex-none text-dim" />
          <span className="min-w-0 truncate">{n.title}</span>
        </button>
      ))}
    </div>
  );
}

/** Opens from a name badge on the map or the row menu in the project list. Real sessions only. Its actions are in its right-click menu: the map's right button only moves the map. */
export function ProjectPopover({
  projectKey,
  isCore,
  project,
  sessions,
  coreNotes,
  color,
  anchor,
  beside,
  autoFocus,
  onEnter,
  onLeave,
  onHold,
  onClose,
  onMigrate,
  onRemove,
  onAnchor,
  onFly,
  mapped,
}: {
  projectKey: string | null;
  isCore: boolean;
  project: Project | undefined;
  sessions: SessionInfo[];
  coreNotes: MemoryNode[];
  color: string;
  anchor: DOMRect;
  beside: boolean; // next to a row in the list, otherwise above the badge: the cluster below stays in sight
  autoFocus: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onHold: (on: boolean) => void;
  onClose: () => void;
  onMigrate: (key: string) => void;
  onRemove: (key: string) => void;
  onAnchor?: (el: HTMLElement | null) => void; // the map takes over its place: it travels with the constellation
  onFly: (key: string) => void;
  mapped: boolean | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [confirm, setConfirm] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const name = isCore ? 'Claude OS' : (project?.name ?? projectKey ?? '');

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [autoFocus, projectKey]);
  useEffect(() => onHold(confirm !== null), [confirm, onHold]);
  useEffect(() => {
    onAnchor?.(ref.current);
    return () => onAnchor?.(null);
  }, [onAnchor, projectKey]);
  const area = useContextMenu(() => (!isCore && project ? projectItems(project, { onFly: () => onFly(project.key), mapped, onMigrate: () => onMigrate(project.key), onRemove: () => onRemove(project.key) }) : []));

  const left = Math.max(10, Math.min(anchor.left + anchor.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 10));
  const position = beside
    ? { left: anchor.right + 14, top: Math.min(anchor.top - 8, window.innerHeight - 320) }
    : isCore && window.innerHeight - anchor.bottom > CORE_ROOM_BELOW // the core's name is under the nucleus: nothing covers the object it names
      ? { left, top: anchor.bottom + 8 }
      : anchor.top > ROOM_ABOVE
      ? { left, bottom: window.innerHeight - anchor.top + 8, maxHeight: anchor.top - TITLE_BAR }
      : { left, top: anchor.bottom + 8 };

  const stop = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(confirm.id)}/stop`, { method: 'POST' });
      toast(t('project.stopped'));
      setConfirm(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={(el) => {
        ref.current = el;
        return area(el);
      }}
      role="dialog"
      aria-label={t('project.aria', { name })}
      data-project-popover
      style={{ ...position, width: WIDTH }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || confirm) return;
        e.stopPropagation();
        opener.current?.focus?.();
        onClose();
      }}
      className="project-popover glass-strong enter-fade fixed z-40 flex flex-col rounded-2xl p-2"
    >
      <div className="mb-1 flex items-center gap-2 px-2 pt-0.5 pb-1">
        {isCore ? <Orbit size={14} className="flex-none text-accent" /> : <i className="size-2.5 flex-none rounded-full" style={{ background: color, opacity: sessions.length ? 1 : 0.5 }} />}
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</h3>
        {isCore && <span className="flex-none text-[11px] text-dim">{t('project.core')}</span>}
      </div>
      {isCore && <CoreNotes notes={coreNotes} onOpen={onClose} />}
      {sessions.length === 0 ? (
        <p className="px-2 pb-1.5 text-xs text-muted">{t('project.noSessions')}</p>
      ) : (
        <div className="panel-scroll max-h-64 min-h-0 overflow-auto">
          {sessions.map((s) => (
            <SessionRow key={s.id} s={s} onStop={() => setConfirm(s)} />
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 border-t border-line2 px-1 pt-2 pb-0.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onClose();
            // Always a new tab: the row's folder button goes to the existing one.
            void createTab(projectKey ? { project: projectKey } : {});
          }}
        >
          <Plus size={12} /> {t('project.newSession')}
        </Button>
      </div>
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)} title={t('project.stopTitle')}>
          <p className="mb-3 text-[13px] text-soft">{t('project.stopBody', { title: confirm.title ?? confirm.name ?? confirm.id })}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={stop}>
              <CircleStop size={13} /> {t('project.stopAction')}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
