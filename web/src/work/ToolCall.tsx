import { Bot, BookOpen, Check, ChevronRight, FilePen, FileText, Globe, ListChecks, Plug, Search, Sparkles, SquareTerminal, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react';
import { createContext, memo, useContext, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Diff } from '@/components/Diff';
import { Button } from '@/components/ui';
import { openDocument } from '@/lib/documents';
import { findPaths, imageUrl, isImagePath } from '@/lib/filePaths';
import { cn, fmtTokens, shortPath } from '@/lib/format';
import type { ChatState } from '@/lib/chat';
import type { ChatBlock, TaskInfo } from '@/lib/types';
import { DENY_TEXTS } from '../../../shared/contract.ts';
import { serverText, t } from '@/lib/i18n';
import { openImage, openPath } from './FileViewer';
import { useSubagentView } from './SubagentView';

export type ToolBlock = Extract<ChatBlock, { type: 'tool_use' }>;

const RESULT_CAP = 20_000;
const PREVIEW_LINES = 4;

// What a subagent's row needs from the whole conversation.
export const ToolContext = createContext<{ sessionId: string | null; filesTab: string | null; inner: Record<string, ToolBlock[]>; tasks: Record<string, TaskInfo> }>({ sessionId: null, filesTab: null, inner: {}, tasks: {} });

export const isAgentTool = (name: string) => name === 'Agent' || name === 'Task';

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  const s =
    str(i.description) && (name === 'Task' || name === 'Agent')
      ? str(i.description)
      : name === 'Bash'
        ? str(i.command)
        : path
          ? shortPath(path)
          : (str(i.pattern) ?? str(i.skill) ?? str(i.query) ?? str(i.url) ?? str(i.description) ?? str(i.title));
  return s ? s.split('\n')[0] : '';
}

function AgentRow({ tool, result }: { tool: ToolBlock; result: { text: string; isError: boolean } | undefined }) {
  const { sessionId, inner, tasks } = useContext(ToolContext);
  const openView = useSubagentView((s) => s.open);
  const task = Object.values(tasks).find((x) => x.toolUseId === tool.id);
  const calls = inner[tool.id] ?? [];
  const uses = task?.toolUses ?? calls.length;
  const last = calls.at(-1);
  const running = task ? task.status === 'running' : !result;
  const summary = toolSummary(tool.name, tool.input);
  const i = (tool.input ?? {}) as Record<string, unknown>;
  const fallback = [str(i.prompt), result?.text && resultText(result.text)].filter(Boolean).join('\n\n');
  return (
    <div>
      <button
        type="button"
        title={t('subagent.open')}
        onClick={() => openView({ sessionId: sessionId!, key: tool.id, title: summary || null, fallback })}
        className="press flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 text-left font-mono text-[11px] text-dim hover:text-muted"
      >
        <Bot size={11} className="flex-none" />
        <span className="flex-none text-muted">{str(i.subagent_type) ?? tool.name}</span>
        {summary && <span className="min-w-0 truncate">· {summary}</span>}
        {running && <i className="dot-working ml-1 block size-1 flex-none rounded-full bg-accent" title={t('tool.running')} />}
        {result?.isError && <TriangleAlert size={11} className="flex-none text-accent" aria-label={t('tool.error')} />}
        <span className="ml-auto flex flex-none items-center gap-1.5 pl-2">
          {uses > 0 && <span>{t('chat.calls', { n: uses })}</span>}
          {task?.tokens != null && <span>{fmtTokens(task.tokens)}</span>}
          <ChevronRight size={11} />
        </span>
      </button>
      {running && (last || task?.lastTool) && (
        <div className="ml-4 truncate font-mono text-[11px] text-dim">⎿ {last ? `${last.name} ${toolSummary(last.name, last.input)}` : task?.lastTool}</div>
      )}
    </div>
  );
}

// The kinds of work in the stream, each with its own colour: styles.css, .tool-badge.
const KINDS: { kind: string; icon: LucideIcon; names: string[] }[] = [
  { kind: 'read', icon: BookOpen, names: ['Read', 'NotebookRead'] },
  { kind: 'edit', icon: FilePen, names: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] },
  { kind: 'bash', icon: SquareTerminal, names: ['Bash', 'BashOutput', 'KillShell'] },
  { kind: 'search', icon: Search, names: ['Grep', 'Glob', 'LS', 'ToolSearch'] },
  { kind: 'web', icon: Globe, names: ['WebFetch', 'WebSearch'] },
  { kind: 'skill', icon: Sparkles, names: ['Skill'] },
  { kind: 'plan', icon: ListChecks, names: ['TodoWrite', 'TaskCreate', 'TaskUpdate'] },
];

function ToolBadge({ name }: { name: string }) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const known = KINDS.find((k) => k.names.includes(name));
  const Icon = mcp ? Plug : known?.icon ?? Wrench;
  return (
    <span data-kind={mcp ? 'mcp' : known?.kind ?? 'other'} title={name} className="tool-badge">
      <Icon size={10} className="flex-none" />
      {mcp ? `${mcp[1]} · ${mcp[2]}` : name}
    </span>
  );
}

const lineCount = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0);

function diffOf(tool: ToolBlock): string | null {
  const i = (tool.input ?? {}) as Record<string, unknown>;
  const pair = (from: unknown, to: unknown) => [...(lineCount(from) ? String(from).split('\n').map((l) => `-${l}`) : []), ...(lineCount(to) ? String(to).split('\n').map((l) => `+${l}`) : [])];
  if (tool.name === 'Edit' && (typeof i.old_string === 'string' || typeof i.new_string === 'string')) return pair(i.old_string, i.new_string).join('\n');
  if (tool.name === 'MultiEdit' && Array.isArray(i.edits)) return (i.edits as Record<string, unknown>[]).flatMap((e) => ['@@', ...pair(e.old_string, e.new_string)]).join('\n');
  if (tool.name === 'Write' && typeof i.content === 'string') return pair('', i.content).join('\n');
  return null;
}

function diffStat(tool: ToolBlock): { add: number; del: number } | null {
  const i = (tool.input ?? {}) as Record<string, unknown>;
  if (tool.name === 'Edit') return { add: lineCount(i.new_string), del: lineCount(i.old_string) };
  if (tool.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = i.edits as Record<string, unknown>[];
    return { add: edits.reduce((n, e) => n + lineCount(e.new_string), 0), del: edits.reduce((n, e) => n + lineCount(e.old_string), 0) };
  }
  if (tool.name === 'Write') return { add: lineCount(i.content), del: 0 };
  return null;
}

// The CLI starts the output of a failed command with this line. A success reports no code at all: none is shown.
const exitCode = (text: string) => /^Exit code (\d+)\b/.exec(text)?.[1] ?? null;

export function PathLink({ path, line, label, className, children }: { path: string; line?: number | null; label: string; className?: string; children?: ReactNode }) {
  const { filesTab } = useContext(ToolContext);
  if (!filesTab) return <span className={className}>{children ?? label}</span>;
  const open = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openPath(filesTab, path, line ?? null);
  };
  return <a href="#file" data-file={path} onClick={open} title={path} className={cn('file-link', className)}>{children ?? label}</a>;
}

const LINKED_CAP = 20_000; // a huge output scanned on every open is not worth a link in it

const LinkedText = memo(function LinkedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    if (text.length > LINKED_CAP) return null;
    const out: (string | { key: number; path: string; line: number | null; label: string })[] = [];
    let at = 0;
    for (const f of findPaths(text)) {
      out.push(text.slice(at, f.index), { key: f.index, path: f.path, line: f.line, label: text.slice(f.index, f.index + f.length) });
      at = f.index + f.length;
    }
    out.push(text.slice(at));
    return out;
  }, [text]);
  if (!parts) return text;
  return parts.map((p) => (typeof p === 'string' ? p : <PathLink key={p.key} path={p.path} line={p.line} label={p.label} />));
});

const MAX_THUMBS = 4;

/** What this call read, wrote or printed that is a picture. */
function ToolImages({ tool, text }: { tool: ToolBlock; text: string }) {
  const paths = useMemo(() => {
    const i = (tool.input ?? {}) as Record<string, unknown>;
    const own = str(i.file_path);
    const named = tool.name === 'Bash' && text.length <= LINKED_CAP ? findPaths(text).map((f) => f.path) : [];
    return [...new Set([...(own ? [own] : []), ...named])].filter(isImagePath).slice(0, MAX_THUMBS);
  }, [tool.input, tool.name, text]);
  return <ImageThumbs paths={paths} />;
}

/** Pictures in a row, a click shows one at full size. A path that turns out to be no picture disappears. */
export function ImageThumbs({ paths }: { paths: string[] }) {
  const { filesTab } = useContext(ToolContext);
  const [failed, setFailed] = useState<string[]>([]);
  if (!filesTab || paths.length === 0) return null;
  return (
    <div className="mt-1 mb-2 ml-4 flex flex-wrap gap-2">
      {paths.filter((p) => !failed.includes(p)).map((p) => (
        <button key={p} type="button" title={p} onClick={() => openImage(imageUrl(filesTab, p), p)} className="press block cursor-zoom-in">
          <img src={imageUrl(filesTab, p)} alt={p} loading="lazy" onError={() => setFailed((x) => [...x, p])} className="max-h-48 max-w-full rounded-md border border-line2" />
        </button>
      ))}
    </div>
  );
}

function ToolLine({ tool, summary }: { tool: ToolBlock; summary: string }) {
  const i = (tool.input ?? {}) as Record<string, unknown>;
  if (!summary) return null;
  if (tool.name === 'Bash') {
    const space = summary.indexOf(' ');
    return (
      <span className="min-w-0 truncate">
        <span className="text-soft">{space < 0 ? summary : summary.slice(0, space)}</span>
        {space >= 0 && summary.slice(space)}
        {str(i.description) && <span className="pl-2 font-sans text-muted">{str(i.description)}</span>}
      </span>
    );
  }
  return <span className="min-w-0 truncate">{summary}</span>;
}

// What the panel told Claude when it denied a request without the user's words: shown in the UI language. Any other text as it is.
const DENY_KEYS = new Map<string, string>(Object.entries(DENY_TEXTS).map(([key, text]) => [text, key]));
const resultText = (text: string) => serverText(text, DENY_KEYS.get(text));

function ToolRow({ tool, result }: { tool: ToolBlock; result: { text: string; isError: boolean } | undefined }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const summary = toolSummary(tool.name, tool.input);
  const text = resultText(result?.text ?? '');
  const i = (tool.input ?? {}) as Record<string, unknown>;
  const diff = open ? diffOf(tool) : null;
  const stat = diffStat(tool);
  const code = result?.isError ? exitCode(text) : null;
  const filePath = str(i.file_path) ?? str(i.notebook_path);
  const bash = tool.name === 'Bash';
  const lines = bash && !open && text ? text.split('\n') : [];

  return (
    <div>
      <div className="flex w-full min-w-0 items-center gap-1.5 py-0.5 font-mono text-[11px] text-dim">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={summary}
          className={cn('press flex items-center gap-1.5 rounded text-left hover:text-muted', filePath ? 'flex-none' : 'min-w-0 flex-1')}
        >
          <ChevronRight size={11} className={cn('flex-none transition-transform duration-150', open && 'rotate-90')} />
          <ToolBadge name={tool.name} />
          {!filePath && <ToolLine tool={tool} summary={summary} />}
        </button>
        {filePath && <PathLink path={filePath} label={summary} className="min-w-0 truncate" />}
        <span className="ml-auto flex flex-none items-center gap-1.5 pl-1">
          {stat && (stat.add > 0 || stat.del > 0) && (
            <span className="diff-stat" title={t('tool.diffStat', { add: stat.add, del: stat.del })}>
              <span className="text-[#8fc99a]">+{stat.add}</span> <span className="text-[#e08b7a]">−{stat.del}</span>
            </span>
          )}
          {!result && <i className="dot-working block size-1 rounded-full bg-accent" title={t('tool.running')} />}
          {result && !result.isError && <Check size={10} className="text-dim" aria-label={t('tool.done')} />}
          {result?.isError && (
            <span className="status-badge" role="status" title={code ? t('tool.exitCode', { code }) : t('tool.error')}>
              <TriangleAlert size={10} aria-label={t('tool.error')} />
              {code ? `exit ${code}` : t('tool.failed')}
            </span>
          )}
        </span>
      </div>
      {result && !result.isError && <ToolImages tool={tool} text={text} />}
      {lines.length > 0 && (
        <pre className={cn('selectable mb-1 ml-4 overflow-hidden font-mono text-[11px] leading-[1.45] whitespace-pre-wrap wrap-anywhere', result?.isError ? 'text-soft' : 'text-dim')}>
          <LinkedText text={lines.slice(0, PREVIEW_LINES).join('\n')} />
          {lines.length > PREVIEW_LINES && <span className="block">{t('tool.moreLines', { n: lines.length - PREVIEW_LINES })}</span>}
        </pre>
      )}
      {open && (
        <div className="selectable mt-1 mb-2 ml-4 flex flex-col gap-1.5 font-mono text-[11px] leading-[1.55]">
          {bash && str(i.command) ? (
            <pre className="max-h-48 overflow-auto rounded border border-line2 bg-bg p-2 whitespace-pre-wrap wrap-anywhere text-soft">$ {String(i.command)}</pre>
          ) : diff !== null ? (
            <Diff diff={diff} maxHeight={256} />
          ) : (
            <pre className="max-h-48 overflow-auto rounded border border-line2 bg-bg p-2 whitespace-pre-wrap wrap-anywhere text-muted">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
          {result ? (
            text ? (
              <>
                <pre className={cn('max-h-80 overflow-auto rounded border bg-bg p-2 whitespace-pre-wrap wrap-anywhere', result.isError ? 'border-accent-deep text-soft' : 'border-line2 text-muted')}>
                  <LinkedText text={full ? text : text.slice(0, RESULT_CAP)} />
                </pre>
                {!full && text.length > RESULT_CAP && (
                  <Button size="sm" variant="ghost" className="self-start" onClick={() => setFull(true)}>
                    {t('tool.showAll')}
                  </Button>
                )}
              </>
            ) : (
              <div className="text-dim">{t('tool.emptyResult')}</div>
            )
          ) : (
            <div className="text-dim">{t('tool.noResult')}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** What a session saved opens from where it was said. */
function DocumentResult({ text }: { text: string }) {
  const doc = useMemo(() => {
    try {
      const parsed = JSON.parse(text) as { id?: unknown; title?: unknown };
      return typeof parsed.id === 'string' && typeof parsed.title === 'string' ? { id: parsed.id, title: parsed.title } : null;
    } catch {
      return null;
    }
  }, [text]);
  if (!doc) return null;
  return (
    <button type="button" data-document-link={doc.id} onClick={() => void openDocument(doc.id)} className="press my-1 ml-4 flex max-w-full items-center gap-2 rounded-lg border border-line bg-white/[.03] px-2.5 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:border-white/20 hover:bg-white/[.07] hover:text-fg">
      <FileText size={13} className="flex-none text-dim" />
      <span className="min-w-0 truncate">{doc.title}</span>
      <ChevronRight size={12} className="flex-none text-dim" />
    </button>
  );
}

const SAVES_DOCUMENT = /^mcp__claude-os__(save|patch)_document$/;

/** With /focus the calls fold into one line; what they saved stays in reach. */
export function SavedDocuments({ tools, results }: { tools: ToolBlock[]; results: ChatState['results'] }) {
  return tools.filter((b) => SAVES_DOCUMENT.test(b.name) && results[b.id] && !results[b.id].isError).map((b) => <DocumentResult key={b.id} text={results[b.id].text} />);
}

function Row({ tool, result }: { tool: ToolBlock; result: { text: string; isError: boolean } | undefined }) {
  const { sessionId } = useContext(ToolContext);
  if (isAgentTool(tool.name) && sessionId) return <AgentRow tool={tool} result={result} />;
  return (
    <>
      <ToolRow tool={tool} result={result} />
      {result && !result.isError && SAVES_DOCUMENT.test(tool.name) && <DocumentResult text={result.text} />}
    </>
  );
}

function sameCalls(a: { tools: ToolBlock[]; results: ChatState['results'] }, b: { tools: ToolBlock[]; results: ChatState['results'] }) {
  return a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i] && a.results[t.id] === b.results[t.id]);
}

export const ToolGroup = memo(function ToolGroup({ tools, results }: { tools: ToolBlock[]; results: ChatState['results'] }) {
  return (
    <div className="border-l border-line pl-2">
      {tools.map((t) => (
        <Row key={t.id} tool={t} result={results[t.id]} />
      ))}
    </div>
  );
}, sameCalls);
