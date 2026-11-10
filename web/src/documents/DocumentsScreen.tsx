import { CloudUpload, Copy, Download, FileCode2, FileText, FolderGit2, Library, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ContextArea } from '@/components/ContextMenu';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import { Button, IconButton, Input, Segmented, Select } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { useApi } from '@/lib/api';
import { KIND_ICON, KIND_LABEL, openDocument } from '@/lib/documents';
import { cn, fmtAgo } from '@/lib/format';
import { locale, t } from '@/lib/i18n';
import { knowledgeLabel } from '../../../shared/documents.ts';
import { askClaude } from '@/lib/microtask';
import { useProjectColors } from '@/lib/projectColors';
import { toast, toastError, useApp } from '@/lib/store';
import type { DocumentInfo, DocumentKind, DocumentKnowledgeInfo, Project } from '@/lib/types';
import { DeleteDialog } from './DeleteDialog';
import { KnowledgeDialog } from './KnowledgeDialog';

const ALL = '@all';
const GENERAL = '@general';
const SEARCH_MS = 160;
const GROUPING_KEY = 'claude-os.documents-group';
type Grouping = 'project' | 'kind' | 'none';
type Pane = 'documents' | 'knowledge';

function Mark({ text, words }: { text: string; words: string[] }) {
  if (words.length === 0) return text;
  const parts = text.split(new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-accent-bg text-fg">{p}</mark> : p));
}

/** The real page, small. Lazy and with no way in: a card is a card, the document opens in its tab. */
function Thumb({ doc }: { doc: DocumentInfo }) {
  const [ready, setReady] = useState(false);
  return (
    <div aria-hidden className="relative aspect-[4/3] overflow-hidden rounded-t-[11px] bg-white">
      <iframe
        title=""
        tabIndex={-1}
        sandbox=""
        loading="lazy"
        src={`/api/documents/${encodeURIComponent(doc.id)}/html?v=${doc.version}`}
        onLoad={() => setReady(true)}
        className={cn('pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0 bg-white transition-opacity duration-300', ready ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  );
}

function Card({ doc, words, menu }: { doc: DocumentInfo; words: string[]; menu: (d: DocumentInfo) => MenuItem[] }) {
  const Icon = KIND_ICON[doc.kind];
  return (
    <ContextArea items={() => menu(doc)} className="min-w-0">
      <button
        type="button"
        data-document={doc.id}
        onClick={() => void openDocument(doc.id)}
        className="press group flex w-full flex-col rounded-xl border border-line2 bg-white/[.02] text-left transition-[border-color,background-color,translate] duration-150 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[.05]"
      >
        <Thumb doc={doc} />
        <div className="flex min-w-0 flex-col gap-1 border-t border-line2 px-3 py-2.5">
          <strong className="line-clamp-2 text-[13px] leading-[1.35] font-medium wrap-anywhere text-soft group-hover:text-fg"><Mark text={doc.title} words={words} /></strong>
          {doc.snippet && <p className="line-clamp-2 text-[11.5px] leading-[1.4] wrap-anywhere text-muted"><Mark text={doc.snippet} words={words} /></p>}
          <span className="flex items-center gap-1.5 text-[11px] text-dim">
            <Icon size={11} className="flex-none" />
            <span className="truncate">{t(KIND_LABEL[doc.kind])}</span>
            <span className="flex-none">· {fmtAgo(doc.updated)}</span>
            {doc.shared && <CloudUpload size={11} className="ml-auto flex-none" aria-label={t('documents.shared')} />}
          </span>
        </div>
      </button>
    </ContextArea>
  );
}

function Group({ title, count, children }: { title: ReactNode; count: number; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 flex items-center gap-2 text-xs font-medium text-muted">{title}<span className="font-normal text-dim">{count}</span></h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">{children}</div>
    </section>
  );
}

const askNew = (project: string | null) => askClaude({
  subject: { kind: 'document library', name: t('documents.title'), project, context: `Use the document tools: list_document_knowledge, read_document_knowledge, then save_document; when no knowledge file fits, make one with create_document_knowledge first.${project ? ` Project key: ${project}.` : ''}` },
  intent: 'change',
  title: t('documents.newTitle'),
  presets: [t('documents.presetReport'), t('documents.presetDocs'), t('documents.presetPlan')],
  placeholder: t('documents.newPlaceholder'),
});

function KnowledgePane() {
  const q = useApi<DocumentKnowledgeInfo[]>('/api/document-knowledge', ['documents']);
  const [open, setOpen] = useState<string | null>(null);
  if (!q.data) return q.error ? <ErrorState className="m-5" message={q.error} onRetry={q.refetch} /> : <Skeleton className="p-5" lines={5} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
      <p className="mb-4 max-w-2xl text-xs leading-[1.5] text-muted">{t('documents.knowledgeHint')}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {q.data.map((k) => {
          const Icon = KIND_ICON[k.kind];
          return (
            <button key={k.id} type="button" data-knowledge={k.id} onClick={() => setOpen(k.id)} className="press flex min-w-0 flex-col gap-1.5 rounded-xl border border-line2 bg-white/[.02] p-3 text-left transition-colors duration-150 hover:border-white/20 hover:bg-white/[.05]">
              <strong className="flex items-center gap-2 text-[13px] font-medium text-soft"><Icon size={13} className="flex-none text-dim" /><span className="truncate">{knowledgeLabel(k, locale()).name}</span></strong>
              <span className="line-clamp-2 text-xs leading-[1.45] text-muted">{knowledgeLabel(k, locale()).description}</span>
              <span className="text-[11px] text-dim">{t('documents.knowledgeCount', { n: k.documents })} · {t(k.customized ? (k.builtin ? 'documents.knowledgeChanged' : 'documents.knowledgeOwn') : 'documents.knowledgeBuiltin')}</span>
            </button>
          );
        })}
      </div>
      {open && <KnowledgeDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function DocumentsScreen({ project: initial, pane: initialPane }: { project?: string | null; pane?: Pane }) {
  const [pane, setPane] = useState<Pane>(initialPane ?? 'documents');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string>(initial === undefined || initial === null ? ALL : initial);
  const [kind, setKind] = useState<string | null>(null);
  const [grouping, setGroupingState] = useState<Grouping>(() => (localStorage.getItem(GROUPING_KEY) as Grouping | null) ?? 'project');
  const setGrouping = (v: Grouping) => {
    localStorage.setItem(GROUPING_KEY, v);
    setGroupingState(v);
  };
  const [deleting, setDeleting] = useState<DocumentInfo | null>(null);
  const [knowledge, setKnowledge] = useState<string | null>(null);
  const { color, nameOf } = useProjectColors();
  const projects = useApi<Project[]>('/api/projects', ['projects']).data ?? [];

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_MS);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (initial !== undefined) setProject(initial ?? ALL);
  }, [initial]);

  const q = useApi<DocumentInfo[]>(`/api/documents?q=${encodeURIComponent(query)}`, ['documents']);
  // A new search has no answer yet: the cards of the last one stay until it comes, so the screen does not blink.
  const lastAnswer = useRef<DocumentInfo[] | undefined>(undefined);
  if (q.data) lastAnswer.current = q.data;
  const found = q.data ?? lastAnswer.current;
  // The filter is by what is shown in the list of all: a project with no documents is no choice.
  const all = useApi<DocumentInfo[]>('/api/documents?q=', ['documents']).data ?? [];
  const words = useMemo(() => query.split(/\s+/).filter(Boolean), [query]);
  const owners = useMemo(() => projects.filter((p) => all.some((d) => d.project === p.key)).sort((a, b) => a.name.localeCompare(b.name)), [projects, all]);
  const kinds = useMemo(() => [...new Set(all.map((d) => d.kind))], [all]);

  const shown = (found ?? []).filter((d) => (project === ALL || (project === GENERAL ? d.project === null : d.project === project)) && (!kind || d.kind === kind));

  const groups = useMemo(() => {
    if (grouping === 'none') return [{ key: 'all', title: null as ReactNode, docs: shown }];
    const map = new Map<string, DocumentInfo[]>();
    for (const d of shown) {
      const key = grouping === 'kind' ? d.kind : d.project ?? GENERAL;
      map.set(key, [...(map.get(key) ?? []), d]);
    }
    return [...map.entries()].map(([key, docs]) => {
      if (grouping === 'kind') {
        const Icon = KIND_ICON[key as DocumentKind];
        return { key, docs, title: <><Icon size={13} className="text-dim" />{t(KIND_LABEL[key as DocumentKind])}</> as ReactNode };
      }
      if (key === GENERAL) return { key, docs, title: <><Library size={13} className="text-dim" />{t('documents.general')}</> as ReactNode };
      return { key, docs, title: <><ProjectIcon project={key} name={nameOf(key)} color={color(key)} size={14} />{nameOf(key)}</> as ReactNode };
    });
  }, [shown, grouping, nameOf, color]);

  const newFor = project === ALL || project === GENERAL ? null : project;

  const menu = (d: DocumentInfo): MenuItem[] => [
    { id: 'documents.open', label: t('documents.open'), icon: FileText, onSelect: () => void openDocument(d.id) },
    { id: 'documents.knowledge', label: t('documents.openKnowledge'), icon: FileCode2, onSelect: () => setKnowledge(d.knowledge) },
    { id: 'documents.download', label: t('documents.download'), icon: Download, apart: true, onSelect: () => { window.location.href = `/api/documents/${encodeURIComponent(d.id)}/html?download=1`; } },
    ...(d.shared ? [{ id: 'documents.shareCopy', label: t('documents.shareCopy'), icon: Copy, onSelect: () => void navigator.clipboard.writeText(d.shared!.url).then(() => toast(t('documents.shareCopied')), toastError) }] : []),
    ...(d.project ? [{ id: 'documents.project', label: nameOf(d.project), icon: FolderGit2, onSelect: () => setProject(d.project!) }] : []),
    { id: 'documents.delete', label: t('documents.delete'), icon: Trash2, danger: true, apart: true, onSelect: () => setDeleting(d) },
  ];
  const screenMenu = (): MenuItem[] => [
    { id: 'documents.new', label: t('documents.newTitle'), icon: Sparkles, onSelect: () => askNew(newFor) },
    { id: 'documents.knowledgePane', label: t('documents.knowledgePane'), icon: FileCode2, onSelect: () => setPane('knowledge') },
  ];

  const filtered = query !== '' || project !== ALL || kind !== null;

  return (
    <ContextArea items={screenMenu} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none flex-wrap items-center gap-2.5 border-b border-line2 px-5 py-2.5">
        <div className="min-w-0">
          <Breadcrumbs items={[{ label: t('nav.home'), view: { kind: 'home' } }, { label: t('documents.title') }]} className="mb-0.5 -ml-1" />
          <h1 className="flex items-center gap-2 text-sm font-medium"><Library size={15} className="text-dim" />{t('documents.title')}</h1>
        </div>
        <span className="ml-3"><Segmented ariaLabel={t('documents.paneAria')} value={pane} onChange={setPane} options={[{ value: 'documents', label: t('documents.paneDocuments') }, { value: 'knowledge', label: t('documents.knowledgePane') }]} /></span>
        <span className="flex-1" />
        {pane === 'documents' && (
          <>
            <div className="relative w-64 min-w-40">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim" />
              <Input aria-label={t('documents.search')} placeholder={t('documents.search')} value={text} onChange={(e) => setText(e.target.value)} className="py-1 pr-7 pl-8 text-xs" />
              {text && <IconButton label={t('documents.searchClear')} className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2" onClick={() => setText('')}><X size={12} /></IconButton>}
            </div>
            <ProjectSelect ariaLabel={t('documents.filterProject')} className="w-44 text-xs" value={project} onChange={(v) => setProject(v ?? ALL)} projects={owners} extra={[{ value: ALL, label: t('documents.allProjects') }, { value: GENERAL, label: t('documents.general') }]} />
            <Select ariaLabel={t('documents.filterKind')} className="w-36 text-xs" value={kind} onChange={setKind} options={[{ value: null, label: t('documents.allKinds') }, ...kinds.map((k) => ({ value: k, label: t(KIND_LABEL[k]), icon: KIND_ICON[k] }))]} />
            <Select ariaLabel={t('documents.groupBy')} className="w-40 text-xs" value={grouping} onChange={(v) => setGrouping((v ?? 'project') as Grouping)} options={[{ value: 'project', label: t('documents.groupProject') }, { value: 'kind', label: t('documents.groupKind') }, { value: 'none', label: t('documents.groupNone') }]} />
          </>
        )}
        <Button variant="primary" onClick={() => askNew(newFor)}><Plus size={13} />{t('documents.new')}</Button>
      </header>
      {pane === 'knowledge' ? (
        <KnowledgePane />
      ) : !found ? (
        q.error ? <ErrorState className="m-5" message={q.error} onRetry={q.refetch} /> : <Skeleton className="p-5" lines={8} />
      ) : shown.length === 0 ? (
        <Empty className="flex-1" icon={filtered ? Search : Library}>{t(filtered ? 'documents.nothing' : 'documents.empty')}</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-5 pt-4 pb-2">
          {groups.map((g) => g.title === null ? (
            <div key={g.key} className="mb-7 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
              {g.docs.map((d) => <Card key={d.id} doc={d} words={words} menu={menu} />)}
            </div>
          ) : (
            <Group key={g.key} title={g.title} count={g.docs.length}>
              {g.docs.map((d) => <Card key={d.id} doc={d} words={words} menu={menu} />)}
            </Group>
          ))}
        </div>
      )}
      {deleting && <DeleteDialog doc={deleting} onClose={() => setDeleting(null)} />}
      {knowledge && <KnowledgeDialog id={knowledge} onClose={() => setKnowledge(null)} />}
    </ContextArea>
  );
}
