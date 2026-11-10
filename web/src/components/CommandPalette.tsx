import * as DialogPrimitive from '@radix-ui/react-dialog';
import { BarChart3, Bot, Boxes, FileText, Library, FolderGit2, FolderPlus, History, Home as HomeIcon, Layers, MessageSquare, NotebookPen, Plus, Search, SquareKanban, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { cn, statusLabel } from '@/lib/format';
import { useApp } from '@/lib/store';
import { openProject } from '@/lib/tabs';
import type { PlannerNote, Project, Tab } from '@/lib/types';
import { t } from '@/lib/i18n';
import { Snippet, useMemorySearch } from '@/lib/useMemorySearch';

interface Cmd {
  id: string;
  group: 'tabs' | 'actions' | 'sections' | 'projects' | 'notes' | 'planner';
  label: string;
  hint?: string;
  snippet?: string;
  icon: ReactNode;
  run: () => void;
}

function CmdLabel({ cmd }: { cmd: Cmd }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{cmd.label}</span>
      {cmd.snippet && <span className="block truncate text-[11.5px] text-dim"><Snippet text={cmd.snippet} /></span>}
    </span>
  );
}

function norm(s: string) {
  return s.toLowerCase().replace(/[-_]/g, ' ');
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data ?? [];
  const projects = useApi<Project[]>('/api/projects', ['projects']).data ?? [];
  const planner = useApi<{ notes: PlannerNote[] }>(open ? '/api/planner' : null, ['planner']).data;
  const [q, setQ] = useState('');
  const hits = useMemorySearch(open ? q : '', 12);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const { go, openNewTab, openNote, openPlanner } = useApp.getState();
    const out: Cmd[] = [];
    out.push({ id: 'home', group: 'sections', label: t('nav.home'), hint: 'Ctrl+1', icon: <HomeIcon size={14} />, run: () => go({ kind: 'home' }) });
    tabs
      .filter((t) => t.kind !== 'root')
      .sort((a, b) => a.order - b.order)
      .forEach((tab, i) => {
        out.push({ id: `tab:${tab.id}`, group: 'tabs', label: tab.title, hint: `${statusLabel(tab.status)}${i < 8 ? ` · Ctrl+${i + 2}` : ''}`, icon: <MessageSquare size={14} />, run: () => go({ kind: 'tab', id: tab.id }) });
      });
    out.push(
      { id: 'new', group: 'actions', label: t('nav.newTab'), icon: <Plus size={14} />, run: () => openNewTab() },
      { id: 'planner', group: 'actions', label: t('palette.openPlanner'), icon: <NotebookPen size={14} />, run: () => openPlanner() },
      { id: 'connect', group: 'actions', label: t('connect.action'), icon: <FolderPlus size={14} />, run: () => useApp.getState().setConnectOpen(true) },
      { id: 'sessions', group: 'sections', label: t('palette.allSessions'), icon: <History size={14} />, run: () => go({ kind: 'sessions' }) },
      { id: 'projects', group: 'sections', label: t('nav.projects'), icon: <Layers size={14} />, run: () => go({ kind: 'projects' }) },
      { id: 'analytics', group: 'sections', label: t('palette.analytics'), icon: <BarChart3 size={14} />, run: () => go({ kind: 'analytics' }) },
      { id: 'kanban', group: 'sections', label: t('nav.kanban'), icon: <SquareKanban size={14} />, run: () => go({ kind: 'kanban' }) },
      { id: 'documents', group: 'sections', label: t('documents.title'), icon: <Library size={14} />, run: () => go({ kind: 'documents' }) },
      { id: 'agents', group: 'sections', label: t('tools.agents'), icon: <Bot size={14} />, run: () => go({ kind: 'tools', pane: 'agents' }) },
      { id: 'skills', group: 'sections', label: t('palette.skills'), icon: <Wrench size={14} />, run: () => go({ kind: 'tools', pane: 'skills' }) },
      { id: 'mcp', group: 'sections', label: t('palette.mcp'), icon: <Wrench size={14} />, run: () => go({ kind: 'tools', pane: 'mcp' }) },
      { id: 'os-plugins', group: 'sections', label: t('tools.osPlugins'), icon: <Boxes size={14} />, run: () => go({ kind: 'os-plugins' }) },
    );
    for (const p of projects) {
      out.push({ id: `p:${p.key}`, group: 'projects', label: p.name, hint: p.liveCount > 0 ? t('palette.active') : undefined, icon: <FolderGit2 size={14} />, run: () => void openProject(p.key) });
    }
    for (const n of hits ?? []) {
      out.push({
        id: `n:${n.id}`,
        group: 'notes',
        label: n.name, snippet: n.snippet,
        hint: n.project ?? t('palette.globalNote'),
        icon: <FileText size={14} />,
        run: () => {
          go({ kind: 'home' });
          openNote(n.id);
        },
      });
    }
    for (const n of planner?.notes ?? []) {
      out.push({ id: `pl:${n.id}`, group: 'planner', label: n.title, hint: n.topic ?? undefined, icon: <NotebookPen size={14} />, run: () => openPlanner(n.id) });
    }
    return out;
  }, [tabs, projects, hits, planner]);

  const results = useMemo(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const match = commands.filter((c) => {
      if (c.group === 'notes' || terms.length === 0) return c.group !== 'projects' && c.group !== 'planner'; // notes come matched and ranked by the search
      const hay = norm(`${c.label} ${c.group === 'planner' ? c.hint ?? '' : ''}`);
      return terms.every((t) => hay.includes(t));
    });
    const order = ['tabs', 'actions', 'sections', 'projects', 'notes', 'planner'];
    const limits: Record<string, number> = { projects: 8, notes: 12, planner: 12 };
    return order.flatMap((g) => {
      const inGroup = match.filter((c) => c.group === g);
      return limits[g] ? inGroup.slice(0, limits[g]) : inGroup;
    });
  }, [commands, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  // No open or close animation: this is used hundreds of times a day.
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-covers-map className="no-drag fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed top-[14vh] left-1/2 z-50 flex max-h-[62vh] w-[min(600px,calc(100vw-48px))] -translate-x-1/2 flex-col overflow-hidden popover rounded-2xl outline-none">
          <DialogPrimitive.Title className="sr-only">{t('palette.title')}</DialogPrimitive.Title>
          <div className="flex flex-none items-center gap-2 border-b border-line2 px-3.5">
            <Search size={14} className="flex-none text-dim" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
              placeholder={t('palette.placeholder')}
              className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-dim"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  run(results[active]);
                }
              }}
            />
          </div>
          <div ref={listRef} id="palette-list" role="listbox" className="min-h-0 overflow-auto p-1.5">
            {results.length === 0 && <div className="px-3 py-6 text-center text-dim">{t('common.nothingFound')}</div>}
            {results.map((c, i) => (
              <div key={c.id}>
                {(i === 0 || results[i - 1].group !== c.group) && <div className="px-2.5 pt-2 pb-1 text-[11px] text-dim">{t(`palette.${c.group}`)}</div>}
                <div
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  onPointerMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5', i === active ? 'bg-raised text-fg' : 'text-muted')}
                >
                  <span className="flex-none text-dim">{c.icon}</span>
                  <CmdLabel cmd={c} />
                  {c.hint && <span className="flex-none text-xs text-dim">{c.hint}</span>}
                </div>
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
