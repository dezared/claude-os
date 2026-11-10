import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, Bot, BookOpen, ChevronsDown, ChevronsUp, FolderGit2, Hash, History, MessageSquarePlus, Milestone, Pencil, Plus, Rows3, Sparkles, SquareKanban, Trash2, UserRoundX } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { claudeItems, ContextArea } from '@/components/ContextMenu';
import { Markdown } from '@/components/Markdown';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Boundary, Skeleton } from '@/components/states';
import { Button, Dialog, Field, Input, Segmented, Textarea } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { api, ApiError, invalidateTopics, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { useProjectColors } from '@/lib/projectColors';
import { toast, toastError, useApp } from '@/lib/store';
import { createTab, openSession } from '@/lib/tabs';
import { tabTitle } from '@/lib/tabTitle';
import type { KanbanCard, KanbanCardSessions, KanbanColumn, KanbanLevel, KanbanPriority, KanbanSprint, Project, SettingsView, Tab } from '@/lib/types';
import { KANBAN_COLUMNS } from '../../../shared/contract.ts';
import { dragMention, mentionFor, tagInChat } from '@/notes/mention';
import { Tag } from './admin/parts';
import { projectView } from './admin/menus';
import { SprintDialog, SprintSwitcher, type SprintEdit } from './KanbanSprints';

const ALL = '@all';
const GENERAL = '@general';
const NO_SPRINT = '@none';
const URL = '/api/kanban';
const COLUMN_LABEL = { backlog: 'kanban.backlog', todo: 'kanban.todo', doing: 'kanban.doing', polish: 'kanban.polish', done: 'kanban.done' } satisfies Record<KanbanColumn, Key>;
const COLUMNS = KANBAN_COLUMNS.map((id) => ({ id, label: COLUMN_LABEL[id] }));
const PRIORITY_LABEL: Record<KanbanPriority, Key> = { low: 'kanban.priorityLow', normal: 'kanban.priorityNormal', high: 'kanban.priorityHigh' };

type Data = { path: string; cards: KanbanCard[]; osProject: string | null; prefixes: Record<string, string>; sprints: KanbanSprint[] };
type Place = { column: KanbanColumn; before: string | null; lane?: string }; // lane: the project swimlane, when grouped

/** On the screen at once, on the server a moment later; a refusal brings the server's order back. */
async function moveCard(id: string, { column, before }: Place) {
  setCached<Data>(URL, (old) => {
    if (!old) return old as unknown as Data;
    const rest = old.cards.filter((c) => c.id !== id);
    const card = old.cards.find((c) => c.id === id);
    if (!card) return old;
    const lastOfColumn = rest.findLastIndex((c) => c.column === column);
    const at = before ? rest.findIndex((c) => c.id === before) : lastOfColumn >= 0 ? lastOfColumn + 1 : rest.length;
    rest.splice(at, 0, { ...card, column });
    return { ...old, cards: rest };
  });
  try {
    await api(`${URL}/cards/${encodeURIComponent(id)}/move`, { method: 'POST', body: { column, before } });
  } catch (e) {
    toastError(e);
  }
  invalidateTopics(['kanban']);
}

function arrange(boardName: string, project: string | null, cards: KanbanCard[]) {
  const list = cards.map((c) => `- [${c.column}] ${c.id}: ${c.title}${c.project ? ` (${c.project})` : ''}, ${c.priority}${c.level ? `, level ${c.level}` : ''}`).join('\n');
  // No project in the subject: only the root session has the board's tools, so that is where this goes.
  askClaude({
    subject: {
      kind: 'kanban board',
      name: boardName,
      context: `Use the tools list_kanban_cards, add_kanban_card and move_kanban_card. ${project ? `Cards of this board belong to project key ${project}.` : 'Set each card\'s project from list_projects, null when it is not about one project.'}\nCards now:\n${list || 'none'}`,
    },
    intent: 'change',
    title: t('kanban.arrange'),
    presets: [t('kanban.presetFromNotes'), t('kanban.presetPriorities'), t('kanban.presetSplit')],
    placeholder: t('kanban.arrangePlaceholder'),
  });
}

// Who works on the card now and what it ran before: the tab opens, an old session resumes or opens for reading.
function CardSessions({ card }: { card: KanbanCard }) {
  const q = useApi<KanbanCardSessions>(`${URL}/cards/${encodeURIComponent(card.id)}/sessions`, ['kanban', 'tabs', 'sessions']);
  const { live, ended } = q.data ?? { live: null, ended: [] };
  if (!live && ended.length === 0) return null;
  const row = 'press flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-white/[.06]';
  return (
    <div aria-label={t('kanban.sessions')} role="group" className="flex flex-col">
      <span className="mb-0.5 text-[11px] text-dim">{t('kanban.sessions')}</span>
      {live && (
        <button type="button" className={row} onClick={() => useApp.getState().go(live.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: live.id })}>
          <Bot size={12} className={cn('flex-none text-accent', live.status === 'working' && 'dot-working')} />
          <span className="min-w-0 flex-1 truncate text-soft">{t('kanban.sessionLive', { name: tabTitle(live, t('tabs.root')) })}</span>
        </button>
      )}
      {ended.map((s) => (
        <button key={s.id} type="button" className={row} onClick={() => void openSession(s)}>
          <History size={12} className="flex-none text-dim" />
          <span className="min-w-0 flex-1 truncate text-soft">{s.title ?? s.name ?? s.lastPrompt ?? s.id}</span>
          <span className="flex-none text-dim">{fmtAgo(s.lastActivity)}</span>
        </button>
      ))}
    </div>
  );
}

function CardDialog({ card, project, sprint, projects, osProject, onClose }: { card: KanbanCard | null; project: string | null; sprint: string | null; projects: Project[]; osProject: string | null; onClose: () => void }) {
  const [title, setTitle] = useState(card?.title ?? '');
  const [description, setDescription] = useState(card?.description ?? '');
  const [owner, setOwner] = useState<string | null>(card ? card.project : project);
  const [priority, setPriority] = useState<KanbanPriority>(card?.priority ?? 'normal');
  const [level, setLevel] = useState<KanbanLevel | 'none'>(card?.level ?? 'none');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const inOs = owner !== null && owner === osProject;
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      // A new card made while one sprint is shown goes into it: otherwise it would vanish from the board at once.
      const body = { title, description, project: owner, priority, ...(inOs ? { level: level === 'none' ? null : level } : {}), ...(!card && sprint ? { sprint } : {}) };
      await api(card ? `${URL}/cards/${encodeURIComponent(card.id)}` : `${URL}/cards`, { method: card ? 'PATCH' : 'POST', body });
      invalidateTopics(['kanban']);
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={card ? `${t('kanban.editTitle')} ${card.id}` : t('kanban.newTitle')} width={560}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label={t('kanban.title')}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <div className="flex flex-col gap-1.5">
          {preview ? (
            <div aria-label={t('kanban.preview')} className="selectable max-h-72 min-h-28 overflow-auto rounded-lg border border-line2 px-3 py-2 text-[13px] wrap-anywhere text-soft"><Markdown text={description || t('kanban.previewEmpty')} /></div>
          ) : (
            <Field label={t('kanban.description')}><Textarea rows={7} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          )}
          <div className="flex items-center gap-2">
            <Segmented ariaLabel={t('kanban.descriptionMode')} value={preview ? 'preview' : 'write'} onChange={(v) => setPreview(v === 'preview')} options={[{ value: 'write' as const, label: t('kanban.write') }, { value: 'preview' as const, label: t('kanban.preview') }]} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={card?.path}>{card ? card.path : t('kanban.markdownHint')}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ProjectSelect ariaLabel={t('kanban.project')} className="w-56 text-xs" value={owner} onChange={setOwner} projects={projects} extra={[{ value: null, label: t('kanban.noProject') }]} />
          <Segmented ariaLabel={t('kanban.priority')} value={priority} onChange={setPriority} options={(['low', 'normal', 'high'] as const).map((value) => ({ value, label: t(PRIORITY_LABEL[value]) }))} />
          {inOs && <Segmented ariaLabel={t('kanban.level')} value={level} onChange={setLevel} options={[{ value: 'none' as const, label: t('kanban.levelNone') }, { value: 'user' as const, label: t('kanban.levelUser') }, { value: 'root' as const, label: t('kanban.levelRoot') }]} />}
        </div>
        {card && <CardSessions card={card} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>{t(card ? 'kanban.save' : 'kanban.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ card, onClose }: { card: KanbanCard; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('kanban.deleteTitle')}>
      <p className="mb-3 text-[13px] wrap-anywhere text-soft">{card.title}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`${URL}/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE' });
              invalidateTopics(['kanban']);
              toast(t('kanban.deleted'));
              onClose();
            } catch (e) {
              toastError(e);
              setBusy(false);
            }
          }}
        >
          <Trash2 size={13} /> {t('kanban.delete')}
        </Button>
      </div>
    </Dialog>
  );
}

const agentTitle = (card: KanbanCard, tabs: Tab[]) => {
  const tab = tabs.find((x) => x.id === card.agentTab);
  return tab ? tabTitle(tab, t('tabs.root')) : card.agent ?? '';
};

export function KanbanBoard({ board = ALL }: { board?: string }) {
  const q = useApi<Data>(URL, ['kanban']);
  const projects = useApi<Project[]>('/api/projects', ['projects']).data ?? [];
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data ?? [];
  const settings = useApi<SettingsView>('/api/settings', ['settings']).data;
  const { color, nameOf } = useProjectColors();
  const [editing, setEditing] = useState<KanbanCard | 'new' | null>(null);
  const [deleting, setDeleting] = useState<KanbanCard | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const dragged = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const focusAfter = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [sprint, setSprint] = useState(ALL);
  const [sprintEdit, setSprintEdit] = useState<SprintEdit | null>(null);
  const [grouped, setGrouped] = useState(false);

  const sprints = q.data?.sprints ?? [];
  // A sprint removed while chosen: the board shows everything again rather than nothing.
  const shownSprint = sprint === ALL || sprint === NO_SPRINT || sprints.some((s) => s.id === sprint) ? sprint : ALL;
  const project = board === ALL || board === GENERAL ? null : board;
  const boardName = board === ALL ? t('kanban.boardAll') : board === GENERAL ? t('kanban.boardGeneral') : nameOf(board);
  const visible = (q.data?.cards ?? [])
    .filter((c) => board === ALL || (board === GENERAL ? c.project === null : c.project === board))
    .filter((c) => shownSprint === ALL || (shownSprint === NO_SPRINT ? !c.sprint : c.sprint === shownSprint));
  const laneOf = (c: KanbanCard) => c.project ?? GENERAL;
  const inColumn = (column: KanbanColumn) => visible.filter((c) => c.column === column);
  // Up and down stay inside the card's lane when the board is grouped.
  const peers = (card: KanbanCard) => inColumn(card.column).filter((c) => !grouped || laneOf(c) === laneOf(card));
  const lanes = [...new Set(visible.map(laneOf))].sort((a, b) => (a === GENERAL ? 1 : b === GENERAL ? -1 : nameOf(a).localeCompare(nameOf(b))));
  const sorted = projects.slice().sort((a, b) => a.name.localeCompare(b.name));

  // A card moved to another column is a new element: the keyboard stays on it.
  useEffect(() => {
    if (!focusAfter.current) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-card="${focusAfter.current}"]`);
    if (el) {
      el.focus();
      focusAfter.current = null;
    }
  });

  const moveByKeys = (card: KanbanCard, key: string) => {
    const column = COLUMNS.findIndex((c) => c.id === card.column);
    const here = peers(card);
    const at = here.findIndex((c) => c.id === card.id);
    let next: Place | null = null;
    if (key === 'ArrowLeft' && column > 0) next = { column: COLUMNS[column - 1].id, before: null };
    if (key === 'ArrowRight' && column < COLUMNS.length - 1) next = { column: COLUMNS[column + 1].id, before: null };
    if (key === 'ArrowUp' && at > 0) next = { column: card.column, before: here[at - 1].id };
    if (key === 'ArrowDown' && at < here.length - 1) next = { column: card.column, before: here[at + 2]?.id ?? null };
    if (!next) return;
    focusAfter.current = card.id;
    void moveCard(card.id, next);
  };

  const onCardKey = (e: KeyboardEvent, card: KanbanCard) => {
    if (e.target !== e.currentTarget) return;
    if (e.shiftKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      moveByKeys(card, e.key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setEditing(card);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      setDeleting(card);
    }
  };

  // The tab takes the card on the way: from here on the board shows who works on it.
  const sendToSession = async (card: KanbanCard) => {
    try {
      const tab = await createTab({ project: card.project ?? undefined, title: card.title });
      if (!tab) return;
      await api(`${URL}/cards/${encodeURIComponent(card.id)}/take`, { method: 'POST', body: { agent: 'Claude', tab: tab.id } });
      invalidateTopics(['kanban']);
      const body = card.description.trim() ? `\n\n${card.description.trim()}` : '';
      await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: `${card.id}: ${card.title}${body}\n\nCard file: ${card.path}. Move the card with move_kanban_card when its state changes.` } });
    } catch (err) {
      toastError(err);
    }
  };

  const mention = (card: KanbanCard) => {
    const hint = `${card.id}: ${card.title.replace(/\s+/g, ' ')}`;
    if (tagInChat(card.path, hint)) return;
    void navigator.clipboard.writeText(mentionFor(card.path, hint)).then(() => toast(t('kanban.mentionCopied')), toastError);
  };

  const openInObsidian = async (card: KanbanCard) => {
    const vault = settings?.obsidian.vaultWindows ?? '';
    const sep = vault.includes('\\') ? '\\' : '/';
    try {
      await api('/api/settings/obsidian/open', { method: 'POST', body: { url: `obsidian://open?path=${encodeURIComponent([vault, 'kanban', `${card.id}.md`].join(sep))}` } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast(t('note.obsidianNoVault', { vault }));
      else toastError(e);
    }
  };

  const release = async (card: KanbanCard) => {
    try {
      await api(`${URL}/cards/${encodeURIComponent(card.id)}`, { method: 'PATCH', body: { agent: null } });
      invalidateTopics(['kanban']);
    } catch (e) {
      toastError(e);
    }
  };

  const setCardSprint = async (card: KanbanCard, id: string | null) => {
    try {
      await api(`${URL}/cards/${encodeURIComponent(card.id)}`, { method: 'PATCH', body: { sprint: id } });
      invalidateTopics(['kanban']);
    } catch (e) {
      toastError(e);
    }
  };

  const sprintItems = (card: KanbanCard): MenuItem[] => [
    ...sprints.filter((s) => s.id !== card.sprint).map((s) => ({ id: `kanban.sprint.${s.id}`, label: t('kanban.sprintTo', { name: s.name }), icon: Milestone, onSelect: () => void setCardSprint(card, s.id) })),
    ...(card.sprint ? [{ id: 'kanban.sprint.none', label: t('kanban.sprintTo', { name: t('kanban.sprintNone') }), icon: Milestone, onSelect: () => void setCardSprint(card, null) }] : []),
  ].map((item, i) => (i === 0 ? { ...item, apart: true } : item));

  const cardMenu = (card: KanbanCard): MenuItem[] => {
    const at = COLUMNS.findIndex((c) => c.id === card.column);
    const here = peers(card);
    const index = here.findIndex((c) => c.id === card.id);
    const agentTab = card.agentTab ? tabs.find((x) => x.id === card.agentTab) : undefined;
    const [change, ask] = claudeItems({ kind: 'kanban card', name: card.title, context: `Card id: ${card.id}\nColumn: ${card.column}\nPriority: ${card.priority}${card.level ? `\nLevel: ${card.level}` : ''}${card.project ? `\nProject: ${card.project}` : ''}\n${card.description}`, project: card.project });
    return [
      { id: 'kanban.open', label: t('kanban.open'), icon: Pencil, onSelect: () => setEditing(card) },
      { id: 'kanban.send', label: t('kanban.send'), icon: MessageSquarePlus, disabled: !card.project, title: card.project ? undefined : t('kanban.sendNeedsProject'), onSelect: () => void sendToSession(card) },
      { id: 'kanban.mention', label: t('kanban.mention'), icon: AtSign, onSelect: () => mention(card) },
      ...(settings?.obsidian.installed ? [{ id: 'kanban.obsidian', label: t('kanban.obsidian'), icon: BookOpen, onSelect: () => void openInObsidian(card) }] : []),
      ...(agentTab ? [{ id: 'kanban.agentOpen', label: t('kanban.agentOpen', { name: tabTitle(agentTab, t('tabs.root')) }), icon: Bot, onSelect: () => useApp.getState().go({ kind: 'tab', id: agentTab.id }) }] : []),
      ...(card.agent ? [{ id: 'kanban.release', label: t('kanban.release'), icon: UserRoundX, onSelect: () => void release(card) }] : []),
      ...(at > 0 ? [{ id: 'kanban.left', label: t('kanban.moveTo', { name: t(COLUMNS[at - 1].label) }), icon: ArrowLeft, apart: true, onSelect: () => moveByKeys(card, 'ArrowLeft') }] : []),
      ...(at < COLUMNS.length - 1 ? [{ id: 'kanban.right', label: t('kanban.moveTo', { name: t(COLUMNS[at + 1].label) }), icon: ArrowRight, onSelect: () => moveByKeys(card, 'ArrowRight') }] : []),
      { id: 'kanban.up', label: t('kanban.up'), icon: ArrowUp, disabled: index <= 0, onSelect: () => moveByKeys(card, 'ArrowUp') },
      { id: 'kanban.down', label: t('kanban.down'), icon: ArrowDown, disabled: index >= here.length - 1, onSelect: () => moveByKeys(card, 'ArrowDown') },
      ...(card.project ? [{ id: 'kanban.project', label: nameOf(card.project), icon: FolderGit2, onSelect: () => useApp.getState().go(projectView(card.project!)) }] : []),
      ...sprintItems(card),
      { ...change, apart: true },
      ask,
      { id: 'kanban.delete', label: t('kanban.delete'), icon: Trash2, danger: true, apart: true, onSelect: () => setDeleting(card) },
    ];
  };

  const boardMenu = (): MenuItem[] => [
    { id: 'kanban.new', label: t('kanban.newTitle'), icon: Plus, onSelect: () => setEditing('new') },
    { id: 'kanban.arrange', label: t('kanban.arrange'), icon: Sparkles, onSelect: () => arrange(boardName, project, visible) },
    { id: 'kanban.sprintNew', label: t('kanban.sprintNew'), icon: Milestone, onSelect: () => setSprintEdit({ kind: 'new' }) },
    { id: 'kanban.group', label: t(grouped ? 'kanban.ungroup' : 'kanban.groupByProject'), icon: Rows3, onSelect: () => setGrouped(!grouped) },
    { id: 'kanban.prefixes', label: t('kanban.prefixes'), icon: Hash, onSelect: () => useApp.getState().go({ kind: 'settings', section: 'projects' }) },
  ];

  // In a lane a card moves between columns of its own project only: a lane is not a way to change the project.
  const onOver = (e: DragEvent<HTMLElement>, column: KanbanColumn, lane?: string) => {
    if (!dragged.current) return;
    const card = visible.find((c) => c.id === dragged.current);
    if (lane !== undefined && card && laneOf(card) !== lane) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-card]')].filter((el) => el.dataset.card !== dragged.current);
    const before = cards.find((el) => {
      const box = el.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    })?.dataset.card ?? null;
    if (place?.column !== column || place.before !== before || place.lane !== lane) setPlace({ column, before, lane });
  };

  const onDrop = (e: DragEvent, column: KanbanColumn, lane?: string) => {
    e.preventDefault();
    const id = dragged.current;
    if (id && place?.column === column && place.lane === lane) void moveCard(id, place);
    dragged.current = null;
    setDraggingId(null);
    setPlace(null);
  };

  const line = <div aria-hidden className="mx-1 h-0.5 flex-none rounded bg-accent" />;

  const columnsOf = (lane?: string) => COLUMNS.map(({ id, label }) => {
    const cards = inColumn(id).filter((c) => lane === undefined || laneOf(c) === lane);
    const here = place?.column === id && place.lane === lane;
    return (
      <section
        key={id}
        aria-label={t('kanban.columnAria', { name: t(label) })}
        onDragOver={(e) => onOver(e, id, lane)}
        onDrop={(e) => onDrop(e, id, lane)}
        className={cn('flex min-h-0 flex-col rounded-xl border border-line2 bg-white/[.02] transition-colors duration-150', here && 'border-white/20 bg-white/[.04]')}
      >
        <h2 className="flex flex-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-soft">
          {t(label)}
          <span className="font-normal text-dim">{cards.length}</span>
        </h2>
        <ul aria-label={t('kanban.cardsAria')} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-2 pb-2">
          {cards.length === 0 && !place && <li className="px-1 py-2 text-xs text-dim">{t('kanban.empty')}</li>}
          {cards.map((c) => (
            <li key={c.id} className="enter-fade flex flex-col gap-1.5">
              {here && place.before === c.id && line}
              <ContextArea items={() => cardMenu(c)}>
                <div
                  role="button"
                  tabIndex={0}
                  data-card={c.id}
                  draggable
                  title={t('kanban.cardHint')}
                  aria-roledescription={t('kanban.editTitle')}
                  onDragStart={(e) => {
                    dragMention(e, c.path, `${c.id}: ${c.title.replace(/\s+/g, ' ')}`); // into a chat in another window
                    e.dataTransfer.effectAllowed = 'copyMove';
                    dragged.current = c.id;
                    setDraggingId(c.id);
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                    setDraggingId(null);
                    setPlace(null);
                  }}
                  onClick={() => setEditing(c)}
                  onKeyDown={(e) => onCardKey(e, c)}
                  className={cn('press cursor-pointer rounded-lg border border-line2 bg-white/[.05] px-2.5 py-2 text-left hover:border-white/20 hover:bg-white/[.08] focus-visible:-outline-offset-1', draggingId === c.id && 'opacity-40')}
                >
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-dim">
                    <span data-card-id className="flex-none font-mono">{c.id}</span>
                    {c.agent && (
                      <span data-card-agent title={t('kanban.agentTitle', { name: agentTitle(c, tabs) })} className="ml-auto flex min-w-0 items-center gap-1 rounded bg-accent-bg px-1.5 text-soft">
                        <Bot size={11} className={cn('flex-none text-accent', tabs.some((x) => x.id === c.agentTab && x.status === 'working') && 'dot-working')} />
                        <span className="min-w-0 truncate">{c.agent}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-start gap-1.5">
                    {c.priority === 'high' && <ChevronsUp size={13} className="mt-0.5 flex-none text-warn" aria-label={t('kanban.priorityHigh')} />}
                    {c.priority === 'low' && <ChevronsDown size={13} className="mt-0.5 flex-none text-dim" aria-label={t('kanban.priorityLow')} />}
                    <span className="min-w-0 wrap-anywhere text-[13px] text-fg">{c.title}</span>
                  </div>
                  {c.description && <p className="mt-1 line-clamp-2 text-xs wrap-anywhere text-muted">{c.description}</p>}
                  {c.project && ((board !== c.project && !grouped) || c.level) && (
                    <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
                      {board !== c.project && !grouped && (
                        <>
                          <ProjectIcon project={c.project} name={nameOf(c.project)} color={color(c.project)} size={13} />
                          <span className="min-w-0 truncate">{nameOf(c.project)}</span>
                        </>
                      )}
                      {c.level === 'user' && <Tag tone="ok" title={t('kanban.levelUserTitle')}>user</Tag>}
                      {c.level === 'root' && <Tag tone="warn" title={t('kanban.levelRootTitle')}>root</Tag>}
                    </span>
                  )}
                </div>
              </ContextArea>
            </li>
          ))}
          {here && place.before === null && line}
        </ul>
      </section>
    );
  });

  return (
    <ContextArea items={boardMenu} className="flex min-h-0 flex-1 flex-col">
      <div ref={root} className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-none flex-wrap items-center gap-3 border-b border-line2 px-5 py-2.5">
          <div className="min-w-0">
            <Breadcrumbs items={[{ label: t('nav.home'), view: { kind: 'home' } }, { label: t('nav.kanban') }]} className="mb-0.5 -ml-1" />
            <h1 className="flex items-center gap-2 text-sm font-medium"><SquareKanban size={15} className="text-dim" />{boardName}</h1>
          </div>
          <span className="flex-1" />
          <span title={t('kanban.hint')} className="hidden max-w-md min-w-0 truncate text-[11px] text-dim min-[1200px]:block">{t('kanban.hint')}</span>
          <ProjectSelect
            ariaLabel={t('kanban.board')}
            className="w-56 text-xs"
            value={board}
            onChange={(v) => useApp.getState().go({ kind: 'kanban', board: v ?? ALL })}
            projects={sorted}
            extra={[{ value: ALL, label: t('kanban.boardAll') }, { value: GENERAL, label: t('kanban.boardGeneral') }]}
          />
          <Button variant="primary" onClick={() => setEditing('new')}><Plus size={13} />{t('kanban.new')}</Button>
        </header>
        <SprintSwitcher sprints={sprints} value={shownSprint} onChange={setSprint} onEdit={setSprintEdit} all={ALL} none={NO_SPRINT} />
        <Boundary query={q} errorClassName="m-3" skeleton={<Skeleton className="p-5" lines={8} />}>
          {() => (
            grouped ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                {lanes.length === 0 && <p className="px-1 text-xs text-dim">{t('kanban.empty')}</p>}
                {lanes.map((lane) => (
                  <section key={lane} aria-label={t('kanban.laneAria', { name: lane === GENERAL ? t('kanban.noProject') : nameOf(lane) })} className="flex flex-none flex-col gap-1.5">
                    <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium text-soft">
                      {lane !== GENERAL && <ProjectIcon project={lane} name={nameOf(lane)} color={color(lane)} size={14} />}
                      <span className="min-w-0 truncate">{lane === GENERAL ? t('kanban.noProject') : nameOf(lane)}</span>
                      <span className="font-normal text-dim">{visible.filter((c) => laneOf(c) === lane).length}</span>
                    </h2>
                    <div className="grid max-h-[28rem] min-h-0 auto-cols-[minmax(13.5rem,1fr)] grid-flow-col gap-2.5">{columnsOf(lane)}</div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 auto-cols-[minmax(13.5rem,1fr)] grid-flow-col gap-2.5 overflow-x-auto overflow-y-hidden p-3">{columnsOf()}</div>
            )
          )}
        </Boundary>
      </div>
      {editing && <CardDialog card={editing === 'new' ? null : editing} project={project} sprint={shownSprint === ALL || shownSprint === NO_SPRINT ? null : shownSprint} projects={sorted} osProject={q.data?.osProject ?? null} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDialog card={deleting} onClose={() => setDeleting(null)} />}
      {sprintEdit && <SprintDialog edit={sprintEdit} onClose={() => setSprintEdit(null)} />}
    </ContextArea>
  );
}
