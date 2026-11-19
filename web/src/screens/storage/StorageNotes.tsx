import { FileText, Lock, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Button, Select } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFlip } from '@/lib/flip';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { useApp } from '@/lib/store';
import { Snippet } from '@/lib/useMemorySearch';
import type { MemoryHealth, MemoryNoteList, MemoryNoteRow, MemoryProjectStats } from '@/lib/types';
import { SectionHead, Tag } from '../admin/parts';
import { NOTE_TYPES, TYPE_COLOR, type Filter } from './StorageProjects';

const PAGE = 50;
const DEBOUNCE_MS = 200;
const HEALTH: MemoryHealth[] = ['malformed', 'broken', 'duplicate', 'orphan'];
// A Select needs a value for "any": the project filter's own null means the global notes.
const ANY = '*';
const GLOBAL = '';

interface Filters { project: string; type: string; tag: string; health: string }
const NONE: Filters = { project: ANY, type: ANY, tag: ANY, health: ANY };

function listPath(q: string, f: Filters, limit: number): string {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (f.project !== ANY) p.set('project', f.project);
  if (f.type !== ANY) p.set('type', f.type);
  if (f.tag !== ANY) p.set('tag', f.tag);
  if (f.health !== ANY) p.set('health', f.health);
  p.set('limit', String(limit));
  return `/api/memory/list?${p}`;
}

function NoteRow({ n, nameOf }: { n: MemoryNoteRow; nameOf: (key: string | null) => string }) {
  const openNote = useApp((s) => s.openNote);
  const { color } = useProjectColors();
  return (
    <li data-flip={n.id}>
      <button type="button" onClick={() => openNote(n.id)} className="press grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-lg px-2 py-1.5 text-left hover:bg-raised">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <i aria-hidden className="block size-1.5 flex-none rounded-full" style={{ background: TYPE_COLOR[n.type ?? ''] ?? 'var(--color-dim)' }} />
            <span className="truncate text-[13px] text-soft">{n.name}</span>
            {!n.connected && <Lock size={11} className="flex-none text-dim" aria-label={t('storage.readOnly')} />}
            {n.health.filter((h) => h !== 'orphan').map((h) => <Tag key={h} tone="warn">{t(`storage.h.${h}`)}</Tag>)}
          </span>
          <span className="block truncate text-[11.5px] text-dim">{n.snippet ? <Snippet text={n.snippet} /> : n.summary}</span>
        </span>
        <span className="flex items-center gap-2 pt-0.5 text-[11px] text-dim">
          {n.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
          <span className="inline-flex max-w-40 items-center gap-1.5 truncate">
            {n.project && <ProjectIcon project={n.project} name={nameOf(n.project)} color={color(n.project)} size={12} />}
            <span className="truncate">{nameOf(n.project)}</span>
          </span>
          <span className="w-16 text-right">{fmtAgo(n.mtime)}</span>
        </span>
      </button>
    </li>
  );
}

/** The search text, settled after a pause, and the filters; a click in the projects table sets project and health. */
function useFilters(from: Filter & { seq: number }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filters>(NONE);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (from.seq) setF({ ...NONE, project: from.project === undefined ? ANY : from.project ?? GLOBAL, health: from.health ?? ANY });
  }, [from]);
  return { text, setText, q, f, set: (patch: Partial<Filters>) => setF((was) => ({ ...was, ...patch })) };
}

function Toolbar({ projects, nameOf, ui }: { projects: MemoryProjectStats[]; nameOf: (key: string | null) => string; ui: ReturnType<typeof useFilters> }) {
  const { text, setText, f, set } = ui;
  const scope = projects.find((p) => (p.project ?? GLOBAL) === f.project);
  const tags = [...new Set([...(scope ? scope.tags : projects.flatMap((p) => p.tags)).map(([tg]) => tg), ...(f.tag === ANY ? [] : [f.tag])])];
  const any = (label: string) => ({ value: ANY, label });
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="relative min-w-60 flex-1">
        <Search size={13} className="pointer-events-none absolute top-2 left-2.5 text-dim" />
        <input aria-label={t('storage.search')} placeholder={t('storage.search')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setText('')}
          className="h-7.5 w-full rounded-md border border-line bg-fg/[.03] pr-7 pl-7.5 text-xs text-fg outline-none placeholder:text-dim focus:border-accent-deep" />
        {text && <button type="button" aria-label={t('common.clear')} onClick={() => setText('')} className="press motion-pop absolute top-1.5 right-1.5 flex size-4.5 items-center justify-center rounded-full text-dim hover:bg-fg/10 hover:text-fg"><X size={11} /></button>}
      </span>
      <Select ariaLabel={t('storage.filterProject')} className="text-xs" value={f.project} onChange={(v) => set({ project: v ?? ANY, tag: ANY })}
        options={[any(t('storage.allProjects')), ...projects.map((p) => ({ value: p.project ?? GLOBAL, label: nameOf(p.project) }))]} />
      <Select ariaLabel={t('storage.filterType')} className="text-xs" value={f.type} onChange={(v) => set({ type: v ?? ANY })}
        options={[any(t('storage.anyType')), ...NOTE_TYPES.map((k) => ({ value: k, label: t(`universe.noteType.${k}`) }))]} />
      <Select ariaLabel={t('storage.filterTag')} className="text-xs" value={f.tag} onChange={(v) => set({ tag: v ?? ANY })}
        options={[any(t('storage.anyTag')), ...tags.map((tg) => ({ value: tg, label: `#${tg}` }))]} />
      <Select ariaLabel={t('storage.filterHealth')} className="text-xs" value={f.health} onChange={(v) => set({ health: v ?? ANY })}
        options={[any(t('storage.anyHealth')), ...HEALTH.map((h) => ({ value: h, label: t(`storage.h.${h}`) }))]} />
    </div>
  );
}

/** Every note of every project, searched through the full-text index and filtered; a note opens in the side panel. */
export function StorageNotes({ projects, nameOf, filter }: { projects: MemoryProjectStats[]; nameOf: (key: string | null) => string; filter: Filter & { seq: number } }) {
  const ui = useFilters(filter);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [ui.q, ui.f]);
  const list = useApi<MemoryNoteList>(listPath(ui.q, ui.f, limit), ['memory']);
  // The last answer stays while the next one travels: the list does not blink on every key.
  const [shown, setShown] = useState<MemoryNoteList | null>(null);
  useEffect(() => {
    if (list.data) setShown(list.data);
  }, [list.data]);
  const box = useRef<HTMLUListElement>(null);
  useFlip(box);
  const data = list.data ?? shown;
  return (
    <section className="mt-7 max-w-6xl">
      <SectionHead icon={FileText} title={t('storage.notesTitle')} aside={data && <span className="text-[11px] text-dim">{fmtInt(data.total)} {tn('unit.note', data.total)}</span>} />
      <Toolbar projects={projects} nameOf={nameOf} ui={ui} />
      {data && data.total === 0 && <p className="motion-fade px-2 py-3 text-xs text-dim">{t('common.nothingFound')}</p>}
      <ul ref={box} aria-label={t('storage.notesTitle')} className={cn('relative flex flex-col transition-opacity duration-150', !list.data && 'opacity-60')}>
        {data?.rows.map((n) => <NoteRow key={n.id} n={n} nameOf={nameOf} />)}
      </ul>
      {data && data.rows.length < data.total && (
        <div className="motion-fade mt-2 flex items-center gap-3">
          <Button size="sm" onClick={() => setLimit((l) => l + PAGE)}>{t('storage.more')}</Button>
          <span className="text-[11px] text-dim">{t('storage.shown', { n: fmtInt(data.rows.length), total: fmtInt(data.total) })}</span>
        </div>
      )}
    </section>
  );
}
