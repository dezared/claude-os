import { AtSign, ChevronRight, FileText, Folder, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { claudeItems, ContextArea } from '@/components/ContextMenu';
import { ErrorState, Skeleton } from '@/components/states';
import { IconButton } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toast, usePersisted } from '@/lib/store';
import type { FileEntry, ProjectFile, Tab } from '@/lib/types';
import { pluginFileIcon, pluginFileMenu, PluginBoundary, pluginOpensMedia, useUiPlugins } from '@/lib/uiPlugins';
import { dragMention, tagInChat } from '@/notes/mention';

const INDENT = 12;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const tag = (path: string) => {
  if (!tagInChat(path)) toast(t('planner.noChat'), 'error');
};

/** Fetched on the spot and again on every `refresh`: a tree and a file change while Claude works. */
export function useFetched<T>(path: string, refresh: string): { data: T | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stale = false;
    api<T>(path).then(
      (data) => !stale && setState({ data, error: null }),
      (e: Error) => !stale && setState((s) => ({ data: s.data, error: e.message })),
    );
    return () => {
      stale = true;
    };
  }, [path, refresh, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

function Row({ tabId, entry, depth, refresh, opened, onOpen, project }: { tabId: string; entry: FileEntry; depth: number; refresh: string; opened: string | null; onOpen: (path: string) => void; project: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const plugins = useUiPlugins();
  const items: MenuItem[] = [
    { id: 'files.tag', label: t('files.tag'), icon: AtSign, onSelect: () => tag(entry.path) },
    ...pluginFileMenu(plugins, { path: entry.path, dir: entry.dir }, { tabId }),
    ...claudeItems({ kind: entry.dir ? 'project folder' : 'project file', name: entry.path, project }),
  ];
  return (
    <>
      <ContextArea items={items} className="block">
        <div
          draggable
          data-file-row={entry.path}
          onDragStart={(e) => dragMention(e, entry.path)}
          className={cn('group flex items-center rounded-md pr-0.5 hover:bg-raised', opened === entry.path && 'bg-raised')}
          style={{ paddingLeft: depth * INDENT + 4 }}
        >
          <button
            type="button"
            aria-expanded={entry.dir ? expanded : undefined}
            onClick={() => (entry.dir ? setExpanded(!expanded) : onOpen(entry.path))}
            title={entry.size === null ? entry.path : `${entry.path} · ${fmtBytes(entry.size)}`}
            className={cn('press flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-[12px]', opened === entry.path ? 'text-fg' : 'text-muted hover:text-fg')}
          >
            {entry.dir ? <ChevronRight size={12} className={cn('flex-none text-dim transition-transform duration-100', expanded && 'rotate-90')} /> : <span className="w-3 flex-none" />}
            {pluginFileIcon(plugins, { name: entry.name, path: entry.path, dir: entry.dir, expanded }) ?? (entry.dir ? <Folder size={12} className="flex-none text-dim" /> : <FileText size={12} className="flex-none text-dim" />)}
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          <IconButton label={t('files.tag')} className="size-5 flex-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => tag(entry.path)}><AtSign size={11} /></IconButton>
        </div>
      </ContextArea>
      {expanded && <Level tabId={tabId} path={entry.path} depth={depth + 1} refresh={refresh} opened={opened} onOpen={onOpen} project={project} />}
    </>
  );
}

function Level({ tabId, path, depth, refresh, opened, onOpen, project }: { tabId: string; path: string; depth: number; refresh: string; opened: string | null; onOpen: (path: string) => void; project: string | null }) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const { data, error, retry } = useFetched<FileEntry[]>(`/api/tabs/${encodeURIComponent(tabId)}/tree${query}`, refresh);
  if (error && !data) return <div className="p-2"><ErrorState message={error} onRetry={retry} /></div>;
  if (!data) return <Skeleton className="p-2" lines={3} />;
  if (data.length === 0) return <div className="py-0.5 text-[11px] text-dim" style={{ paddingLeft: depth * INDENT + 20 }}>{t('files.empty')}</div>;
  return data.map((e) => <Row key={e.path} tabId={tabId} entry={e} depth={depth} refresh={refresh} opened={opened} onOpen={onOpen} project={project} />);
}

/** Line numbers and code in two blocks, not a node per line: a big file stays cheap to scroll. */
export const Code = memo(function Code({ text }: { text: string }) {
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  const numbers = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  return (
    <div className="flex min-h-full min-w-fit font-mono text-[12px] leading-[1.55]">
      <pre aria-hidden className="sticky left-0 flex-none border-r border-line2 bg-bg px-2 py-2 text-right text-dim select-none">{numbers}</pre>
      <pre data-testid="file-code" className="selectable flex-1 px-3 py-2 whitespace-pre text-muted">{text}</pre>
    </div>
  );
});

function FileView({ tabId, path, refresh, onClose }: { tabId: string; path: string; refresh: string; onClose: () => void }) {
  const { data, error, retry } = useFetched<ProjectFile>(`/api/tabs/${encodeURIComponent(tabId)}/file?path=${encodeURIComponent(path)}`, refresh);
  const file = data?.path === path ? data : null;
  const plugins = useUiPlugins();
  const PluginView = plugins.find((c) => c.fileView)?.fileView;
  const media = pluginOpensMedia(plugins, path);
  const [width, setWidth] = useState<number | null>(null);
  return (
    <div role="region" aria-label={t('files.viewAria', { path })} style={PluginView && width ? { width } : undefined} className="flex w-[clamp(320px,30vw,720px)] min-w-0 flex-none flex-col border-l border-line2">
      <header className="flex flex-none items-center gap-1 border-b border-line2 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-soft" title={path}>{path}</span>
        {file && <span className="flex-none text-[11px] text-dim">{fmtBytes(file.size)}</span>}
        <IconButton label={t('files.tag')} className="size-6 flex-none" onClick={() => tag(path)}><AtSign size={12} /></IconButton>
        <IconButton label={t('common.close')} className="size-6 flex-none" onClick={onClose}><X size={12} /></IconButton>
      </header>
      {file?.truncated && !media && <p role="status" className="flex-none border-b border-line2 px-3 py-1 text-[11px] text-accent">{t('files.truncated', { size: fmtBytes(file.size) })}</p>}
      <div className="relative min-h-0 flex-1 overflow-auto bg-bg">
        {error && !file ? (
          <div className="p-3"><ErrorState message={error} onRetry={retry} /></div>
        ) : !file ? (
          <Skeleton className="p-3" lines={8} />
        ) : file.kind === 'binary' && !media ? (
          <p className="p-3 text-xs text-dim">{t('files.binary', { size: fmtBytes(file.size) })}</p>
        ) : PluginView ? (
          <PluginBoundary key={path} fallback={<Code text={file.text ?? ''} />}><PluginView tabId={tabId} path={path} file={file} line={null} setPaneWidth={setWidth} /></PluginBoundary>
        ) : file.text === '' ? (
          <p className="p-3 text-xs text-dim">{t('files.emptyFile')}</p>
        ) : (
          <Code text={file.text ?? ''} />
        )}
      </div>
    </div>
  );
}

/** Just enough of an IDE: look, tag into the chat. Anything more belongs to the real one behind the IDE button. */
export function FilesPanel({ tab, turnKey }: { tab: Tab; turnKey: string }) {
  const [open, setOpen] = usePersisted('claude-os.files-open', true);
  const [opened, setOpened] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const refresh = `${turnKey}|${manual}`;

  if (!open) {
    return (
      <div className="hidden min-h-0 flex-none flex-col items-center border-r border-line2 py-1 app:flex">
        <IconButton label={t('files.show')} className="size-7" onClick={() => setOpen(true)}><PanelLeftOpen size={14} /></IconButton>
      </div>
    );
  }
  return (
    <div className="hidden min-h-0 flex-none border-r border-line2 app:flex">
      <nav aria-label={t('files.title')} className="flex w-56 min-w-0 flex-none flex-col">
        <header className="flex flex-none items-center gap-0.5 border-b border-line2 py-1 pr-1 pl-3">
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{t('files.title')}</span>
          <IconButton label={t('files.refresh')} className="size-6" onClick={() => setManual((n) => n + 1)}><RefreshCw size={12} /></IconButton>
          <IconButton label={t('files.hide')} className="size-6" onClick={() => setOpen(false)}><PanelLeftClose size={13} /></IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          <Level tabId={tab.id} path="" depth={0} refresh={refresh} opened={opened} onOpen={setOpened} project={tab.project} />
        </div>
      </nav>
      {opened && <FileView tabId={tab.id} path={opened} refresh={refresh} onClose={() => setOpened(null)} />}
    </div>
  );
}

