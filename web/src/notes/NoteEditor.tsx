import { Check, ImageOff, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Button, IconButton } from '@/components/ui';
import { api, ApiError, setCached } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { PlannerFolder, PlannerNote } from '@/lib/types';
import { openImage } from '@/work/FileViewer';
import { parseItem } from '../../../shared/plannerItems.ts';

export interface PlannerList {
  dir: string;
  folders: PlannerFolder[];
  notes: PlannerNote[];
}

const SAVE_DELAY_MS = 400;

export const noteUrl = (id: string) => `/api/planner/${encodeURIComponent(id)}`;
export const imagePrefix = (dir: string | undefined) => (dir ? `${dir}/images/` : null);
export const imageSrc = (line: string, prefix: string) => `/api/planner/images/${encodeURIComponent(line.trim().slice(prefix.length))}`;
/** What the server would refuse: only blank lines and empty items. */
export const noContent = (text: string) => !text.split('\n').some((line) => line.trim() && parseItem(line)?.text !== '');

export const patchCachedNote = (saved: PlannerNote) => setCached<PlannerList | undefined>('/api/planner', (cur) => cur && { ...cur, notes: cur.notes.map((n) => (n.id === saved.id ? { ...n, ...saved } : n)) });

export function Thumb({ src, title, onRemove }: { src: string; title: string; onRemove?: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span title={title} className="flex h-[72px] items-center gap-1.5 rounded-md border border-line2 px-2 text-[11px] text-dim"><ImageOff size={12} className="flex-none" />{t('planner.imageBroken')}</span>;
  return (
    <span className="group/thumb relative block max-w-full">
      <button type="button" aria-label={t('planner.imageOpen')} title={t('planner.imageOpen')} onClick={() => openImage(src, title)} className="press block max-w-full cursor-zoom-in overflow-hidden rounded-md border border-line2 hover:border-white/25">
        <img src={src} alt={t('planner.imageAlt')} loading="lazy" draggable={false} onError={() => setBroken(true)} className="block h-[72px] max-w-full object-cover" />
      </button>
      {onRemove && <IconButton label={t('planner.imageRemove')} onClick={onRemove} className="absolute top-1 right-1 size-5 bg-black/60 text-white opacity-0 group-focus-within/thumb:opacity-100 group-hover/thumb:opacity-100 enabled:hover:bg-black/80 enabled:hover:text-white"><X size={11} /></IconButton>}
    </span>
  );
}

// An edit belongs to the note, not to its row or to the panel: filing moves the file, a filter hides the row,
// the panel closes or floats, and the words stay until they are saved. The id does not change with the path.
interface Draft {
  text: string;
  saved: string; // what the server has of it
  version: string; // of `saved`
  conflict: boolean;
}

export const useDrafts = create<Record<string, Draft>>(() => ({}));
const setDraft = (id: string, draft: Draft | null) => useDrafts.setState((cur) => {
  const next = { ...cur };
  if (draft) next[id] = draft;
  else delete next[id];
  return next;
}, true);

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Set<string>();
const typingIn = new Set<string>();

// One call at a time per note, each naming the version the last one returned. Nothing is sent over a conflict: that is the owner's choice.
function flush(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const draft = useDrafts.getState()[id];
  if (!draft || draft.conflict || saving.has(id)) return;
  if (draft.text === draft.saved || noContent(draft.text)) {
    // While the field is in use the words on screen stay as typed: the server trims them, and an empty note is not saved at all.
    if (!typingIn.has(id)) setDraft(id, null);
    return;
  }
  const { text, version } = draft;
  saving.add(id);
  api<PlannerNote>(noteUrl(id), { method: 'PUT', body: { text, version } }).then(
    (note) => {
      patchCachedNote(note);
      const now = useDrafts.getState()[id];
      if (now) setDraft(id, { ...now, saved: text, version: note.version });
      saving.delete(id);
      flush(id);
    },
    (e) => {
      saving.delete(id);
      const now = useDrafts.getState()[id];
      if (e instanceof ApiError && e.status === 409 && now) setDraft(id, { ...now, conflict: true });
      else toastError(e);
    },
  );
}

const later = (id: string) => {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => flush(id), SAVE_DELAY_MS));
};

async function keepMine(id: string) {
  try {
    const { version } = await api<PlannerNote>(noteUrl(id));
    const now = useDrafts.getState()[id];
    if (!now) return;
    setDraft(id, { ...now, saved: '', version, conflict: false });
    flush(id);
  } catch (e) {
    toastError(e);
  }
}

// A note's text as what is on screen: runs of plain lines, single items, runs of pictures. Offsets are into the whole text.
type Block =
  | { kind: 'text'; from: number; to: number; text: string }
  | { kind: 'item'; from: number; to: number; start: number; indent: string; done: boolean; text: string }
  | { kind: 'images'; lines: { from: number; to: number; line: string }[] };

const ITEM_HEAD = /^\s*- \[[ xX]\] */;

function blocksOf(text: string, prefix: string | null): Block[] {
  const out: Block[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const from = at;
    const to = at + line.length;
    at = to + 1;
    const item = parseItem(line);
    const last = out.at(-1);
    if (item) {
      const head = ITEM_HEAD.exec(line)![0].length;
      out.push({ kind: 'item', from, to, start: from + head, indent: item.indent, done: item.done, text: line.slice(head) }); // with the space being typed at its end
    } else if (prefix !== null && line.trim().startsWith(prefix)) {
      if (last?.kind === 'images') last.lines.push({ from, to, line });
      else out.push({ kind: 'images', lines: [{ from, to, line }] });
    } else if (last?.kind === 'text') {
      last.to = to;
      last.text += `\n${line}`;
    } else out.push({ kind: 'text', from, to, text: line });
  }
  return out;
}

const itemLine = (indent: string, done: boolean, text: string) => `${indent}- [${done ? 'x' : ' '}] ${text}`;
const FIELD = 'block w-full resize-none bg-transparent outline-none wrap-anywhere [field-sizing:content] read-only:cursor-default';

export function NoteEditor({ note, dir, busy }: { note: PlannerNote; dir: string | undefined; busy: boolean }) {
  const draft = useDrafts((s) => s[note.id]);
  const text = (draft?.text ?? note.text).replace(/\r\n?/g, '\n');
  const box = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null);
  const prefix = imagePrefix(dir);

  useEffect(() => {
    const id = note.id;
    return () => {
      typingIn.delete(id);
      flush(id);
    };
  }, [note.id]);

  // A line that turned into an item or back is another element by now: the caret follows, as a place in the whole text.
  useLayoutEffect(() => {
    const at = caret.current;
    caret.current = null;
    if (at === null) return;
    for (const el of box.current?.querySelectorAll('textarea') ?? []) {
      const start = Number(el.dataset.start);
      if (at < start || at > start + el.value.length) continue;
      if (document.activeElement !== el) el.focus();
      if (el.selectionStart !== at - start) el.setSelectionRange(at - start, at - start);
      return;
    }
  });

  const replace = (from: number, to: number, value: string, at: number | null, now = false) => {
    const next = text.slice(0, from) + value + text.slice(to);
    const base = draft ?? { saved: note.text, version: note.version, conflict: false };
    caret.current = at;
    setDraft(note.id, { ...base, text: next });
    if (now) flush(note.id);
    else later(note.id);
  };

  const removeLine = (from: number, to: number, at: number | null) => {
    if (to < text.length) replace(from, to + 1, '', at, at === null);
    else replace(Math.max(0, from - 1), to, '', at, at === null);
  };

  const onItemKey = (e: KeyboardEvent<HTMLTextAreaElement>, b: Extract<Block, { kind: 'item' }>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!b.text.trim()) replace(b.from, b.to, '', b.from); // an empty item ends the list
      else {
        const head = itemLine(b.indent, false, '');
        const cut = el.selectionStart;
        const rest = b.text.slice(el.selectionEnd);
        replace(b.start + cut, b.to, `\n${head}${rest}`, b.start + cut + 1 + head.length);
      }
    } else if (e.key === 'Backspace' && !b.text && text !== text.slice(b.from, b.to)) {
      e.preventDefault();
      removeLine(b.from, b.to, Math.max(0, b.from - 1));
    }
  };

  // Each run of the text is a field of its own, and the arrows still walk through them as one.
  const onArrow = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const up = e.key === 'ArrowUp' && el.selectionEnd === 0;
    const down = e.key === 'ArrowDown' && el.selectionStart === el.value.length;
    if (!up && !down) return;
    const fields = [...(box.current?.querySelectorAll('textarea') ?? [])];
    const next = fields[fields.indexOf(el) + (up ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
    const end = up ? next.value.length : 0;
    next.setSelectionRange(end, end);
  };

  return (
    <div
      ref={box}
      onFocus={(e) => {
        if (e.target instanceof HTMLTextAreaElement) typingIn.add(note.id);
      }}
      onBlur={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        if (e.relatedTarget instanceof HTMLTextAreaElement && box.current?.contains(e.relatedTarget)) return;
        typingIn.delete(note.id);
        flush(note.id);
      }}
      className="flex flex-col gap-0.5 text-[13px] leading-[1.55]"
    >
      {draft?.conflict && (
        <div role="status" className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="min-w-0 flex-1 basis-48">{t('note.conflict')}</span>
          <button type="button" className="press flex-none text-soft hover:text-fg" onClick={() => void keepMine(note.id)}>{t('note.overwrite')}</button>
          <button type="button" className="press flex-none text-soft hover:text-fg" onClick={() => setDraft(note.id, null)}>{t('note.takeDisk')}</button>
        </div>
      )}
      {blocksOf(text, prefix).map((b, i) => {
        if (b.kind === 'images') {
          return (
            <div key={`i${i}`} className="flex flex-wrap gap-1.5 py-1">
              {b.lines.map((l) => <Thumb key={l.line} src={imageSrc(l.line, prefix!)} title={l.line.trim()} onRemove={busy ? undefined : () => removeLine(l.from, l.to, null)} />)}
            </div>
          );
        }
        if (b.kind === 'text') {
          return (
            <textarea
              key={`t${i}`}
              rows={1}
              aria-label={t('planner.editor')}
              data-start={b.from}
              value={b.text}
              readOnly={busy}
              spellCheck={false}
              onChange={(e) => replace(b.from, b.to, e.target.value, b.from + e.target.selectionStart)}
              onKeyDown={onArrow}
              className={cn(FIELD, 'text-soft')}
            />
          );
        }
        return (
          <div key={`c${i}`} data-planner-item={b.text} className="group/item flex items-start gap-2">
            <label className="flex h-[1.55em] flex-none cursor-pointer items-center">
              <input type="checkbox" className="peer sr-only" checked={b.done} disabled={busy} onChange={(e) => replace(b.from, b.to, itemLine(b.indent, e.target.checked, b.text), null, true)} />
              <span aria-hidden className="flex size-3.5 items-center justify-center rounded-[4px] border border-white/25 transition-colors duration-150 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-1 peer-focus-visible:outline-accent-deep">
                <Check size={10} strokeWidth={3.5} className={cn('text-on-accent transition-[opacity,scale] duration-150', b.done ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} />
              </span>
            </label>
            <textarea
              rows={1}
              aria-label={t('planner.itemText')}
              data-start={b.start}
              value={b.text}
              readOnly={busy}
              spellCheck={false}
              onChange={(e) => replace(b.from, b.to, itemLine(b.indent, b.done, e.target.value), b.start + e.target.selectionStart)}
              onKeyDown={(e) => {
                onItemKey(e, b);
                if (!e.defaultPrevented) onArrow(e);
              }}
              className={cn(FIELD, 'min-w-0 flex-1', b.done ? 'text-dim line-through' : 'text-soft')}
            />
            {!busy && <IconButton label={t('planner.itemRemove', { text: b.text })} className="size-[1.55em] opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100" onClick={() => removeLine(b.from, b.to, null)}><X size={11} /></IconButton>}
          </div>
        );
      })}
    </div>
  );
}
