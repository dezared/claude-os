import { AppWindow, ArrowLeft, ArrowRight, AtSign, ChevronDown, ChevronRight, FolderMinus, FolderPlus, GripHorizontal, ListTree, NotebookPen, PaintBucket, PanelRightClose, Pencil, PictureInPicture2, Plus, Search, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ColorPicker } from '@/components/ColorPicker';
import { claudeItems, ContextArea, useContextMenu } from '@/components/ContextMenu';
import { popoutBridge, usePopouts } from '@/components/desktop';
import { clampFloat, dragFloat, plannerFloat } from '@/components/plannerFloat';
import { Empty, ErrorState, Skeleton, Spinner } from '@/components/states';
import { Button, IconButton } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { spendNote } from '@/lib/account';
import { api, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import { inPopout } from '@/lib/popout';
import { toast, toastError, useApp } from '@/lib/store';
import type { PlannerFolder, PlannerNote } from '@/lib/types';
import { clipboardFiles, readFile } from '@/work/Composer';
import { VoiceButton } from '@/work/voice/VoiceButton';
import { FOLDER_COLORS } from '../../../shared/contract.ts';
import { parseItem } from '../../../shared/plannerItems.ts';
import { dragMention, tagInChat } from './mention';
import { imagePrefix, imageSrc, noContent, NoteEditor, noteUrl, patchCachedNote, type PlannerList, Thumb, useDrafts } from './NoteEditor';

const NOTE_MIME = 'application/x-claude-os-note';
const FOLDER_MIME = 'application/x-claude-os-folder'; // a chip moved along the bar, never a note into a folder

const itemsOf = (text: string) => text.split('\n').flatMap((line) => parseItem(line) ?? []);

// The note's items travel with their tools: the session gets only a path and would otherwise not know it can mark them.
const hintFor = (note: PlannerNote) => (itemsOf(note.text).length > 0 ? t('planner.itemsHint', { id: note.id }) : undefined);

const tag = (note: PlannerNote) => {
  if (!tagInChat(note.path, hintFor(note))) toast(t('planner.noChat'), 'error');
};

function NoteField({ text, setText, images, setImages, dir, busy, setBusy, onSave }: { text: string; setText: (text: string) => void; images: string[]; setImages: (fn: (cur: string[]) => string[]) => void; dir: string | undefined; busy: boolean; setBusy: (on: boolean) => void; onSave: (andFile: boolean) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(false);
  const prefix = imagePrefix(dir);
  const empty = images.length === 0 && noContent(text);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onSave(false);
      return;
    }
    const el = e.currentTarget;
    const from = el.selectionStart === 0 ? 0 : el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const end = el.value.indexOf('\n', el.selectionStart);
    const to = end < 0 ? el.value.length : end;
    const item = parseItem(el.value.slice(from, to));
    if (!item) return;
    // The field's own edit, so React state and Ctrl+Z both follow it.
    e.preventDefault();
    if (item.text) document.execCommand('insertText', false, `\n${item.indent}- [ ] `);
    else {
      el.setSelectionRange(from, to);
      document.execCommand('delete');
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (pictures.length === 0) return toast(t('planner.notImage'), 'error');
    setBusy(true);
    setUploading(true);
    void (async () => {
      try {
        for (const file of pictures) {
          const { path } = await api<{ path: string }>('/api/planner/images', { method: 'POST', body: await readFile(file) });
          setImages((cur) => [...cur, path]);
        }
      } catch (err) {
        toastError(err);
      }
      setUploading(false);
      setBusy(false);
    })();
  };

  // Filing is the rarer of the two: it waits on the right click of the field, and of the note later on.
  const menu = useContextMenu([{ id: 'planner.file', label: t('planner.file'), icon: Sparkles, disabled: empty || busy, onSelect: () => onSave(true) }]);
  return (
    <div ref={menu} className="flex flex-col rounded-xl bg-white/[.045] shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)] transition-[background-color,box-shadow] duration-150 focus-within:bg-white/[.06] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)]">
      <textarea
        ref={box}
        autoFocus
        aria-label={t('planner.placeholder')}
        value={text}
        placeholder={t('planner.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-[32vh] min-h-[4.6em] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-[1.55] wrap-anywhere text-fg outline-none [field-sizing:content] placeholder:text-dim"
      />
      {images.length > 0 && prefix && (
        <div className="flex max-h-44 flex-wrap gap-1.5 overflow-auto px-3 pb-1.5">
          {images.map((path) => <Thumb key={path} src={imageSrc(path, prefix)} title={path} onRemove={() => setImages((cur) => cur.filter((p) => p !== path))} />)}
        </div>
      )}
      <div className="flex items-center gap-1 p-1.5">
        <VoiceButton box={box} onText={setText} onBusy={setBusy} itemsMode />
        {uploading && <Spinner size={11} />}
        <span role={uploading ? 'status' : undefined} className="sr-only">{uploading ? t('planner.uploading') : ''}</span>
        <span className="flex-1" />
        <Button variant="primary" disabled={empty || busy} onClick={() => onSave(false)}>{t('planner.saveOnly')}</Button>
      </div>
    </div>
  );
}

function NoteBadge({ note }: { note: PlannerNote }) {
  if (note.job && note.job.state !== 'failed') return <span role="status" className="flex flex-none items-center gap-1 text-accent"><Spinner size={10} />{note.job.state === 'queued' ? t('planner.queued') : t('planner.sent')}</span>;
  if (note.job) return <span title={note.job.error} className="flex flex-none items-center gap-1 text-bad"><TriangleAlert size={11} />{t('planner.failed')}</span>;
  return null;
}

/** The name, in place. Saved on leaving the field; an empty one is not a name. */
function TitleField({ note, onActive }: { note: PlannerNote; onActive: (on: boolean) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const commit = () => {
    const clean = value?.trim();
    setValue(null);
    onActive(false);
    if (!clean || clean === note.title) return;
    patchCachedNote({ ...note, title: clean });
    api<PlannerNote>(noteUrl(note.id), { method: 'PATCH', body: { title: clean } }).then(patchCachedNote, toastError);
  };
  return (
    <textarea
      rows={1}
      aria-label={t('planner.noteTitle')}
      value={value ?? note.title}
      maxLength={80}
      spellCheck={false}
      onFocus={() => onActive(true)}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setValue(null);
          // After the state above: the blur must not save what was just dropped.
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
      className="block w-full resize-none bg-transparent text-[13px] font-medium wrap-anywhere text-fg outline-none [field-sizing:content]"
    />
  );
}

function NoteRow({ note, dir, folders, showFolder, expanded, onToggle, onFile, onRemove, onMove }: { note: PlannerNote; dir: string | undefined; folders: PlannerFolder[]; showFolder: boolean; expanded: boolean; onToggle: () => void; onFile: () => void; onRemove: () => void; onMove: (folder: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const text = useDrafts((s) => s[note.id]?.text) ?? note.text;
  const [naming, setNaming] = useState(false);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);
  const hint = hintFor(note);
  const items = itemsOf(text);
  const busy = Boolean(note.job && note.job.state !== 'failed');
  const failed = note.job?.state === 'failed';
  const askOnly = claudeItems({ kind: 'planner note', name: note.title, context: `File: ${note.path}${hint ? `\n(${hint})` : ''}\n\n${note.text}` }).filter((i) => i.id === 'claude.ask');
  const folder = folders.find((f) => f.id === note.folder);
  const menu: MenuItem[] = [
    ...(inPopout ? [] : [{ id: 'planner.tag', label: t('planner.tag'), icon: AtSign, onSelect: () => tag(note) }]), // no chat in this window: a note is dragged to one
    { id: 'planner.file', label: failed ? t('planner.retry') : t('planner.file'), icon: Sparkles, disabled: busy, title: note.job?.error, onSelect: onFile },
    { id: 'planner.decompose', label: t('planner.decompose'), icon: ListTree, title: spendNote(), onSelect: () => void api(`${noteUrl(note.id)}/decompose`, { method: 'POST' }).catch(toastError) },
    ...folders.filter((f) => f !== folder).map((f, i) => ({ id: `planner.folder.${f.id}`, label: t('planner.moveTo', { name: f.name }), icon: FolderPlus, apart: i === 0, onSelect: () => onMove(f.id) })),
    ...(folder ? [{ id: 'planner.folderOut', label: t('planner.moveOut'), icon: FolderMinus, onSelect: () => onMove(null) }] : []),
    ...askOnly.map((i) => ({ ...i, apart: true })),
    { id: 'planner.delete', label: t('planner.delete'), icon: Trash2, danger: true, onSelect: onRemove },
  ];
  const meta = [note.topic, note.date].filter(Boolean).join(' · ');
  const created = Date.parse(note.created);
  const aside = (
    <>
      {items.length > 0 && <span className={cn('flex-none text-[11px] tabular-nums', items.every((i) => i.done) ? 'text-accent' : 'text-dim')}>{items.filter((i) => i.done).length}/{items.length}</span>}
      {!Number.isNaN(created) && <span className="flex-none text-[11px] text-dim tabular-nums">{fmtAgo(created)}</span>}
    </>
  );
  const line = (note.job || meta || (showFolder && folder)) && (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
      <NoteBadge note={note} />
      {showFolder && folder && <span data-planner-folder={folder.name} className="enter-fade flex max-w-[40%] min-w-0 flex-none items-center gap-1 font-medium" style={{ color: folder.color }}><span className="size-1.5 flex-none rounded-full bg-current" /><span className="truncate">{folder.name}</span></span>}
      {meta && <span className="min-w-0 truncate">{meta}</span>}
    </span>
  );
  return (
    <ContextArea items={menu} className="block">
      <div ref={ref} data-planner-note={note.id} className={cn('rounded-lg transition-colors duration-100', expanded ? 'bg-white/[.045]' : 'hover:bg-white/[.04]')}>
        <div
          draggable={!naming}
          onDragStart={(e) => {
            dragMention(e, note.path, hint);
            e.dataTransfer.setData(NOTE_MIME, note.id);
          }}
        >
          {expanded ? (
            <div className="flex items-start gap-1.5 px-2 pt-2 pb-1">
              <button type="button" aria-expanded aria-label={note.title} title={note.path} onClick={onToggle} className="press flex h-[1.5em] flex-none items-center text-[13px] text-dim hover:text-fg"><ChevronRight size={12} className="rotate-90" /></button>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1"><TitleField note={note} onActive={setNaming} /></span>
                  {aside}
                </span>
                {line}
              </span>
            </div>
          ) : (
            <button type="button" aria-expanded={false} title={note.path} onClick={onToggle} className="press flex w-full min-w-0 items-start gap-1.5 px-2 py-1.5 text-left">
              <ChevronRight size={12} className="mt-[3px] flex-none text-dim" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-soft">{note.title}</span>
                  {aside}
                </span>
                {line}
              </span>
            </button>
          )}
        </div>
        {expanded && <div className="px-2 pt-1 pb-2.5 pl-[26px]"><NoteEditor note={note} dir={dir} busy={busy} /></div>}
      </div>
    </ContextArea>
  );
}

function FolderInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      aria-label={t('planner.folderName')}
      value={value}
      maxLength={60}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value.trim() || null);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
      className="w-28 rounded-md bg-white/[.08] px-2 py-0.5 text-xs text-fg outline-none [field-sizing:content]"
    />
  );
}

/**
 * `folder`: the chip of a folder, dragged along the bar; `onDropFolder` gets the dragged one's id and whether it goes after this one.
 * `onPaint`: a click on the dot picks its colour, without opening the folder; the dot keeps its own size, a wider target
 * would take clicks meant for a short name. By keyboard the same is in the chip's menu.
 */
function FolderChip({ label, color, count, active, items, onClick, onDropNote, folder, onDropFolder, onPaint }: { label: string; color?: string; count: number; active: boolean; items?: MenuItem[]; onClick: () => void; onDropNote: (id: string) => void; folder?: string; onDropFolder?: (id: string, after: boolean) => void; onPaint?: () => void }) {
  const [over, setOver] = useState(false);
  const [side, setSide] = useState<'before' | 'after' | null>(null); // where a dragged chip would go
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(NOTE_MIME);
  const takesFolder = (e: DragEvent) => Boolean(onDropFolder) && e.dataTransfer.types.includes(FOLDER_MIME);
  return (
    <ContextArea items={items ?? []}>
      <button
        type="button"
        aria-pressed={active}
        title={label}
        onClick={onClick}
        draggable={Boolean(folder)}
        onDragStart={folder ? (e) => {
          e.dataTransfer.setData(FOLDER_MIME, folder);
          e.dataTransfer.effectAllowed = 'move';
        } : undefined}
        onDragEnter={(e) => { if (accepts(e)) setOver(true); }}
        onDragLeave={() => {
          setOver(false);
          setSide(null);
        }}
        onDragOver={(e) => {
          if (takesFolder(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = e.currentTarget.getBoundingClientRect();
            setSide(e.clientX > r.left + r.width / 2 ? 'after' : 'before');
            return;
          }
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          setOver(false);
          setSide(null);
          const moved = takesFolder(e) && e.dataTransfer.getData(FOLDER_MIME);
          if (moved) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            if (moved !== folder) onDropFolder!(moved, e.clientX > r.left + r.width / 2);
            return;
          }
          const id = e.dataTransfer.getData(NOTE_MIME);
          if (!id) return;
          e.preventDefault();
          onDropNote(id);
        }}
        className={cn('press relative flex max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors duration-100', active ? 'bg-white/[.1] text-fg' : 'text-muted hover:bg-white/[.05] hover:text-fg', over && 'bg-accent-bg text-accent shadow-[inset_0_0_0_1px_var(--color-accent-deep)]')}
      >
        {side && <span data-folder-insert={side} className={cn('pointer-events-none absolute inset-y-0.5 w-0.5 rounded-full bg-accent', side === 'before' ? '-left-px' : '-right-px')} />}
        {color && (
          <span
            data-folder-dot
            onClick={onPaint && ((e) => {
              e.stopPropagation();
              onPaint();
            })}
            style={{ backgroundColor: color }}
            className={cn('size-2 flex-none rounded-full transition-[background-color,transform] duration-150', onPaint && 'cursor-pointer hover:scale-150')}
          />
        )}
        <span className="min-w-0 truncate">{label}</span>
        {count > 0 && <span className="flex-none text-[11px] text-dim tabular-nums">{count}</span>}
      </button>
    </ContextArea>
  );
}

function FolderBar({ folders, notes, show, setShow, onMove, onChanged }: { folders: PlannerFolder[]; notes: PlannerNote[]; show: string | null; setShow: (id: string | null) => void; onMove: (note: string, folder: string | null) => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null); // a folder's id, or NEW
  const [painting, setPainting] = useState<string | null>(null);
  const finish = (call: () => Promise<unknown>) => {
    setEditing(null);
    call().then(onChanged, toastError);
  };
  const menu = useContextMenu([{ id: 'planner.folderNew', label: t('planner.folderNew'), icon: FolderPlus, onSelect: () => setEditing(NEW_FOLDER) }]);
  const paint = (id: string, color: string) => {
    api(`/api/planner/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { color } }).then(onChanged, toastError);
  };
  // Moved at once on the screen; a refusal puts the old order back.
  const reorder = (ids: string[]) => {
    const was = folders;
    const byId = new Map(folders.map((f) => [f.id, f]));
    const put = (list: PlannerFolder[]) => setCached<PlannerList | undefined>('/api/planner', (cur) => cur && { ...cur, folders: list });
    put(ids.map((id) => byId.get(id)!));
    api('/api/planner/folders/order', { method: 'PUT', body: { ids } }).then(onChanged, (e) => {
      put(was);
      toastError(e);
      onChanged();
    });
  };
  const ids = folders.map((f) => f.id);
  const dropFolder = (id: string, target: string, after: boolean) => {
    const rest = ids.filter((x) => x !== id);
    rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id);
    if (rest.join() !== ids.join()) reorder(rest);
  };
  const shift = (at: number, by: number) => {
    const next = [...ids];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    reorder(next);
  };
  return (
    <div ref={menu} role="group" aria-label={t('planner.folders')} className="group/folders flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
      <FolderChip label={t('planner.all')} count={0} active={show === null} onClick={() => setShow(null)} onDropNote={(id) => onMove(id, null)} />
      {folders.map((f, at) => (editing === f.id ? (
        <FolderInput key={f.id} initial={f.name} onDone={(name) => (name && name !== f.name ? finish(() => api(`/api/planner/folders/${encodeURIComponent(f.id)}`, { method: 'PATCH', body: { name } })) : setEditing(null))} />
      ) : (
        <ColorPicker key={f.id} value={f.color} onChange={(color) => paint(f.id, color)} palette={FOLDER_COLORS} label={t('planner.folderColor')} open={painting === f.id} onOpenChange={(on) => setPainting(on ? f.id : null)}>
          <span className="flex min-w-0">
            <FolderChip
              label={f.name}
              color={f.color}
              count={notes.filter((n) => n.folder === f.id).length}
              active={show === f.id}
              onClick={() => setShow(f.id)}
              onDropNote={(id) => onMove(id, f.id)}
              folder={f.id}
              onDropFolder={(id, after) => dropFolder(id, f.id, after)}
              onPaint={() => setPainting(f.id)}
              items={[
                { id: 'planner.folderRename', label: t('planner.folderRename'), icon: Pencil, onSelect: () => setEditing(f.id) },
                { id: 'planner.folderColor', label: t('planner.folderColor'), icon: PaintBucket, onSelect: () => setPainting(f.id) },
                ...(at > 0 ? [{ id: 'planner.folderLeft', label: t('planner.folderLeft'), icon: ArrowLeft, onSelect: () => shift(at, -1) }] : []),
                ...(at < folders.length - 1 ? [{ id: 'planner.folderRight', label: t('planner.folderRight'), icon: ArrowRight, onSelect: () => shift(at, 1) }] : []),
                { id: 'planner.folderDelete', label: t('planner.folderDelete'), icon: Trash2, danger: true, onSelect: () => finish(() => api(`/api/planner/folders/${encodeURIComponent(f.id)}`, { method: 'DELETE' })) },
              ]}
            />
          </span>
        </ColorPicker>
      )))}
      {editing === NEW_FOLDER ? (
        <FolderInput initial="" onDone={(name) => (name ? finish(() => api('/api/planner/folders', { method: 'POST', body: { name } })) : setEditing(null))} />
      ) : (
        <IconButton label={t('planner.folderNew')} className="size-6 text-dim opacity-0 transition-opacity duration-150 group-hover/folders:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(NEW_FOLDER)}><Plus size={13} /></IconButton>
      )}
    </div>
  );
}

const NEW_FOLDER = '__new__';
const SHOWN_FOLDER = 'claude-os.plannerFolder';

// The field's draft, with its pictures, outlives the panel: it moves with the planner to and from its own window.
const FIELD_KEY = 'claude-os.plannerField';

function readField(): { text: string; images: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(FIELD_KEY) ?? '{}') as { text?: unknown; images?: unknown };
    return { text: typeof saved.text === 'string' ? saved.text : '', images: Array.isArray(saved.images) ? saved.images.filter((p) => typeof p === 'string') : [] };
  } catch {
    return { text: '', images: [] };
  }
}

export function Planner({ focus }: { focus: string | null }) {
  const planner = useApi<PlannerList>('/api/planner', ['planner']);
  const [text, setText] = useState(() => readField().text);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(focus);
  const [search, setSearch] = useState('');
  const [show, setShowRaw] = useState<string | null>(() => localStorage.getItem(SHOWN_FOLDER));
  // Pictures of the draft stand apart from its words: the field stays readable, and the paths join the text on saving.
  const [images, setImages] = useState<string[]>(() => readField().images);
  useEffect(() => {
    if (text || images.length > 0) localStorage.setItem(FIELD_KEY, JSON.stringify({ text, images }));
    else localStorage.removeItem(FIELD_KEY);
  }, [text, images]);
  const setShow = (id: string | null) => {
    if (id) localStorage.setItem(SHOWN_FOLDER, id);
    else localStorage.removeItem(SHOWN_FOLDER);
    setShowRaw(id);
  };
  useEffect(() => {
    setExpanded(focus);
    if (focus) {
      setSearch('');
      setShowRaw(null);
    }
  }, [focus]);

  // The hidden service session does this: nothing shows up in the owner's conversation.
  const file = (note: Pick<PlannerNote, 'id'>) => api(`${noteUrl(note.id)}/file`, { method: 'POST' }).then(planner.refetch, toastError);

  const save = async (andFile: boolean) => {
    if ((images.length === 0 && noContent(text)) || busy) return;
    setBusy(true);
    try {
      // Into the folder that is open: what is written there belongs there.
      const note = await api<PlannerNote>('/api/planner', { method: 'POST', body: { text: images.length ? [text.trimEnd(), ...images].filter(Boolean).join('\n') : text, folder } });
      setText('');
      setImages([]);
      planner.refetch();
      if (andFile) await file(note);
    } catch (e) {
      toastError(e);
    }
    setBusy(false);
  };

  const remove = (note: PlannerNote) => {
    api(noteUrl(note.id), { method: 'DELETE' }).then(planner.refetch, toastError);
  };
  const move = (id: string, folder: string | null) => {
    api(`${noteUrl(id)}/folder`, { method: 'PUT', body: { folder } }).then(planner.refetch, toastError);
  };

  const notes = planner.data?.notes;
  const folders = planner.data?.folders ?? [];
  const folder = folders.find((f) => f.id === show)?.id ?? null; // one deleted elsewhere: everything
  const words = search.trim().toLowerCase();
  const shown = (notes ?? []).filter((n) => {
    if (folder && n.folder !== folder) return false;
    return !words || [n.title, n.text, n.topic ?? '', folders.find((f) => f.id === n.folder)?.name ?? ''].some((part) => part.toLowerCase().includes(words));
  });
  const asks = claudeItems(
    { kind: 'planner', name: t('planner.title'), context: planner.data ? `The notes are markdown files in ${planner.data.dir}` : undefined },
    { askPresets: [t('planner.presetSoon'), t('planner.presetStale')] },
  ).filter((i) => i.id === 'claude.ask');

  return (
    <ContextArea items={asks} className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none p-3 pb-2.5">
        <NoteField text={text} setText={setText} images={images} setImages={setImages} dir={planner.data?.dir} busy={busy} setBusy={setBusy} onSave={(andFile) => void save(andFile)} />
      </div>
      {notes && (notes.length > 0 || folders.length > 0) && (
        <div className="flex flex-none items-start gap-2 px-3 pb-2">
          <FolderBar folders={folders} notes={notes} show={folder} setShow={setShow} onMove={move} onChanged={planner.refetch} />
          {/* An icon until it is wanted: opens on focus and stays open while it holds words. */}
          <label className="flex h-6 w-6 flex-none cursor-text items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-dim transition-[width,background-color,color] duration-200 ease-out hover:text-fg focus-within:w-44 focus-within:bg-white/[.06] has-[input:not(:placeholder-shown)]:w-44 has-[input:not(:placeholder-shown)]:bg-white/[.06]">
            <Search size={13} className="flex-none" />
            <input type="search" aria-label={t('planner.search')} placeholder={t('planner.search')} value={search} onChange={(e) => setSearch(e.target.value)} className="w-36 flex-none bg-transparent text-xs text-fg outline-none placeholder:text-dim" />
          </label>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {planner.error && !notes ? (
          <ErrorState message={planner.error} onRetry={planner.refetch} />
        ) : !notes ? (
          <Skeleton lines={4} />
        ) : notes.length === 0 ? (
          <Empty>{t('planner.empty')}</Empty>
        ) : shown.length === 0 ? (
          <Empty>{words ? t('planner.noMatch') : t('planner.folderEmpty')}</Empty>
        ) : (
          <div className="flex flex-col gap-px">
            {/* One flat list, newest first: filing changes a row, and never remounts it. */}
            {shown.map((n) => (
              <NoteRow key={n.id} note={n} dir={planner.data?.dir} folders={folders} showFolder={!folder} expanded={expanded === n.id} onToggle={() => setExpanded(expanded === n.id ? null : n.id)} onFile={() => void file(n)} onRemove={() => remove(n)} onMove={(to) => move(n.id, to)} />
            ))}
          </div>
        )}
      </div>
    </ContextArea>
  );
}

/** The width of a work tab's side column, or a floating window over the app: the same element either way, so nothing is rebuilt. */
export function PlannerPanel() {
  const open = useApp((s) => s.plannerOpen);
  const focus = useApp((s) => s.plannerNote);
  const close = useApp((s) => s.closePlanner);
  const floating = plannerFloat.use((s) => s.floating);
  const collapsed = plannerFloat.use((s) => s.collapsed);
  const frame = useRef<HTMLElement>(null);
  const windows = popoutBridge();
  const out = usePopouts((s) => s.keys.includes('planner'));
  // Where the planner stands is not asked often: the right click of its header, and a window from the burger menu too.
  const headerMenu = useContextMenu([
    floating
      ? { id: 'planner.dock', label: t('planner.dock'), icon: PanelRightClose, onSelect: () => plannerFloat.setFloating(false) }
      : windows
        ? { id: 'popout.planner', label: t('popout.planner'), icon: AppWindow, onSelect: () => { close(); windows.openPopout({ kind: 'planner' }); } }
        : { id: 'planner.float', label: t('planner.float'), icon: PictureInPicture2, onSelect: () => plannerFloat.setFloating(true) },
  ]);
  // While it has a window of its own, that window is the planner.
  useEffect(() => {
    if (!open || !out || !windows) return;
    close();
    windows.openPopout({ kind: 'planner' });
  }, [open, out, windows, close]);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!open || !floating || !el) return;
    const fit = () => {
      const p = clampFloat(plannerFloat.use.getState().pos, el.offsetWidth, el.offsetHeight);
      el.style.left = `${p.left}px`;
      el.style.bottom = `${p.bottom}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      el.style.left = '';
      el.style.bottom = '';
    };
  }, [open, floating]);
  if (!open) return null;
  return (
    <aside
      ref={frame}
      role="complementary"
      aria-label={t('planner.title')}
      className={cn(
        'glass-reading enter-fade z-30 flex flex-col overflow-hidden rounded-2xl bg-[#0e0e12]!',
        floating ? cn('fixed z-40 w-[min(620px,calc(100vw-16px))]', !collapsed && 'h-[min(780px,calc(100vh-64px))]') : 'absolute top-2 right-2 bottom-2 w-[min(430px,calc(100vw-16px))]',
      )}
    >
      <header
        ref={headerMenu}
        aria-label={floating ? t('planner.floatHandle') : undefined}
        onPointerDown={floating ? (e) => dragFloat(e, frame.current, plannerFloat.setPos) : undefined}
        className={cn('flex flex-none items-center gap-2 border-b border-line2 py-1 pr-1.5 pl-3.5', floating && 'cursor-grab touch-none select-none active:cursor-grabbing')}
      >
        {floating ? <GripHorizontal size={12} className="flex-none text-dim" /> : <NotebookPen size={14} className="flex-none text-accent" />}
        <strong className="min-w-0 flex-1 truncate text-[13px] font-medium">{t('planner.title')}</strong>
        {floating && (
          <IconButton label={collapsed ? t('planner.floatRestore') : t('planner.floatMinimize')} className="size-7" onClick={() => plannerFloat.setCollapsed(!collapsed)}>
            {collapsed ? <Plus size={13} /> : <ChevronDown size={13} />}
          </IconButton>
        )}
        <IconButton label={t('common.hide')} className="size-7" onClick={close}><X size={13} /></IconButton>
      </header>
      <div className={cn('flex min-h-0 flex-1 flex-col', floating && collapsed && 'hidden')}>
        <Planner focus={focus} />
      </div>
    </aside>
  );
}
