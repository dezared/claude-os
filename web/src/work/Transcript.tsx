import { ArrowDown, Bot, Brain, ChevronRight, Square, SquareTerminal, TriangleAlert, Wrench } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChatMarkdown } from '@/components/MarkdownChat';
import { Button } from '@/components/ui';
import { useShowCost } from '@/lib/account';
import { api } from '@/lib/api';
import { useChatWidthClass } from '@/lib/chatWidth';
import { PASTED_BLOCK } from '../../../shared/pasted.ts';
import { useFocusMode } from '@/lib/focus';
import { cn, fmtTokens, fmtUsd, tokenSum } from '@/lib/format';
import type { ChatState, Item, RequestItem } from '@/lib/chat';
import { localizeAttachedFiles } from '@/lib/serverLines';
import { toastError } from '@/lib/store';
import type { ChatBlock } from '@/lib/types';
import { openImage } from './FileViewer';
import { RequestCard } from './RequestCards';
import { TerminalText } from './TerminalText';
import { isAgentTool, SavedDocuments, ToolContext, ToolGroup, type ToolBlock } from './ToolCall';
import { t } from '@/lib/i18n';

type Node =
  | { t: 'user'; key: string; blocks: ChatBlock[] }
  | { t: 'text'; key: string; text: string }
  | { t: 'thinking'; key: string; text: string }
  | { t: 'image'; key: string; mediaType: string; base64: string }
  | { t: 'tools'; key: string; tools: ToolBlock[] }
  | { t: 'subagent'; key: string; id: string; tools: ToolBlock[] }
  | { t: 'request'; key: string; item: RequestItem }
  | { t: 'result'; key: string; item: Extract<Item, { k: 'result' }> }
  | { t: 'notice'; key: string; item: Extract<Item, { k: 'notice' }> }
  | { t: 'terminal'; key: string; item: Extract<Item, { k: 'terminal' }> };

// These two tools show up as interactive cards, a tool row next to the card would only repeat it.
const CARD_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Claude's bookkeeping for the home widget: the bar shows it, a row per report would only clutter the conversation.
const PROGRESS_TOOL = 'mcp__claude-os__report_progress';

function flatten(items: Item[], readOnly: boolean): { nodes: Node[]; inner: Record<string, ToolBlock[]> } {
  const out: Node[] = [];
  const inner: Record<string, ToolBlock[]> = {};
  const agentCalls = new Set<string>();
  for (const item of items) {
    if (item.k !== 'assistant') continue;
    for (const b of item.blocks) if (b.type === 'tool_use' && isAgentTool(b.name)) agentCalls.add(b.id);
  }
  for (const item of items) {
    switch (item.k) {
      case 'user':
        out.push({ t: 'user', key: item.key, blocks: item.blocks });
        break;
      case 'assistant':
        item.blocks.forEach((b, i) => {
          const key = `${item.key}:${i}`;
          if (b.type === 'text') {
            if (b.text.trim()) out.push({ t: 'text', key, text: b.text });
          } else if (b.type === 'thinking') {
            if (b.text.trim()) out.push({ t: 'thinking', key, text: b.text });
          } else if (b.type === 'image') {
            out.push({ t: 'image', key, mediaType: b.mediaType, base64: b.base64 });
          } else if (b.type === 'tool_use') {
            if (!readOnly && CARD_TOOLS.has(b.name)) return;
            if (b.name === PROGRESS_TOOL) return;
            const last = out.at(-1);
            if (b.subagent && agentCalls.has(b.subagent)) {
              // The call that started the subagent shows this; everything else is inside its own view.
              (inner[b.subagent] ??= []).push(b);
            } else if (b.subagent) {
              if (last?.t === 'subagent' && last.id === b.subagent) last.tools.push(b);
              else out.push({ t: 'subagent', key, id: b.subagent, tools: [b] });
            } else if (last?.t === 'tools') {
              last.tools.push(b);
            } else {
              out.push({ t: 'tools', key, tools: [b] });
            }
          }
        });
        break;
      case 'request':
        out.push({ t: 'request', key: item.key, item });
        break;
      case 'result':
        out.push({ t: 'result', key: item.key, item });
        break;
      case 'notice':
        out.push({ t: 'notice', key: item.key, item });
        break;
      case 'terminal':
        out.push({ t: 'terminal', key: item.key, item });
        break;
    }
  }
  return { nodes: out, inner };
}

function InlineImage({ src, alt, className }: { src: string; alt: string; className: string }) {
  return (
    <button type="button" title={t('chat.imageOpen')} onClick={() => openImage(src, alt)} className="press block w-fit max-w-full cursor-zoom-in">
      <img alt={alt} src={src} className={className} />
    </button>
  );
}

// A long paste goes out in a tag (see pastes.ts): in the bubble it is a block of its own, folded to a few lines.
function PastedBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure); // the column can change width: /view
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  return (
    <span data-testid="pasted-block" className="my-1 block rounded-md border border-line px-2.5 py-1.5 text-[13px] text-soft">
      <span ref={body} className={open ? 'block' : 'line-clamp-6'}>{text}</span>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="press mt-1 text-[11px] text-dim select-none hover:text-fg">
          {t(open ? 'chat.pasteCollapse' : 'chat.pasteExpand')}
        </button>
      )}
    </span>
  );
}

function withPastes(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(PASTED_BLOCK)) {
    parts.push(text.slice(at, m.index), <PastedBlock key={m.index} text={m[1]} />);
    at = m.index + m[0].length;
  }
  return at === 0 ? text : [...parts, text.slice(at)];
}

function UserBubble({ blocks }: { blocks: ChatBlock[] }) {
  const text = localizeAttachedFiles(blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'), (path) => t('chat.attachedFile', { path }));
  const images = blocks.filter((b): b is Extract<ChatBlock, { type: 'image' }> => b.type === 'image');
  return (
    <div className="selectable ml-auto w-fit max-w-[min(560px,100%)] rounded-[10px] bg-raised px-3.5 py-2.5 whitespace-pre-wrap wrap-anywhere">
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((b, i) => (
            <InlineImage key={i} alt={t('chat.attachment')} src={`data:${b.mediaType};base64,${b.base64}`} className="max-h-40 rounded-md" />
          ))}
        </div>
      )}
      {withPastes(text)}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l border-line pl-2.5 font-mono text-[11px] text-dim">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="press flex items-center gap-1.5 rounded hover:text-muted">
        <Brain size={11} /> {t('chat.thinking')}
        <ChevronRight size={11} className={cn('transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open && <div className="selectable mt-1.5 font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

function Subagent({ id, tools, results }: { id: string; tools: ToolBlock[]; results: ChatState['results'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-line2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="press flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[11px] text-dim hover:bg-raised hover:text-muted">
        <Bot size={12} className="flex-none" />
        <span className="min-w-0 flex-1 truncate">{t('chat.subagent', { id })}</span>
        <span>{t('chat.calls', { n: tools.length })}</span>
        <ChevronRight size={11} className={cn('transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t border-line2 p-2.5">
          <ToolGroup tools={tools} results={results} />
        </div>
      )}
    </div>
  );
}

/** /focus on: a group of tool calls is one line, what happened inside stays one click away. */
function FocusedTools({ tools, results }: { tools: ToolBlock[]; results: ChatState['results'] }) {
  const [open, setOpen] = useState(false);
  const names = [...new Set(tools.map((b) => b.name))].join(', ');
  return (
    <div data-testid="focused-tools" className="border-l border-line pl-2.5 font-mono text-[11px] text-dim">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="press flex max-w-full items-center gap-1.5 rounded hover:text-muted">
        <Wrench size={11} className="flex-none" />
        <span className="flex-none">{t('focus.tools', { n: tools.length })}</span>
        <span className="min-w-0 truncate">{names}</span>
        {tools.some((b) => !results[b.id]) && <i className="dot-working block size-1 flex-none rounded-full bg-accent" title={t('tool.running')} />}
        {tools.some((b) => results[b.id]?.isError) && <TriangleAlert size={11} className="flex-none text-accent" aria-label={t('tool.error')} />}
        <ChevronRight size={11} className={cn('flex-none transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open ? <div className="mt-1.5"><ToolGroup tools={tools} results={results} /></div> : <SavedDocuments tools={tools} results={results} />}
    </div>
  );
}

function TerminalScreen({ item }: { item: Extract<Item, { k: 'terminal' }> }) {
  return (
    <div className="rounded-md border border-line2">
      <div className="flex items-center gap-2 border-b border-line2 px-2.5 py-1.5 font-mono text-[11px] text-dim">
        <SquareTerminal size={12} className="flex-none" />
        <span className="min-w-0 flex-1 truncate">{item.command}</span>
        {!item.done && <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" role="status" aria-label={t('chat.terminalRunning')} />}
      </div>
      {item.screen && <TerminalText text={item.screen} runs={item.runs} />}
      {item.error && <div role="alert" className="px-2.5 py-1.5 text-xs text-accent">{item.error}</div>}
    </div>
  );
}

function CostPart({ usd }: { usd: number }) {
  return useShowCost() ? <> · {t('chat.apiEquivalent', { cost: fmtUsd(usd) })}</> : null;
}

const NodeView = memo(function NodeView({ node, results, tabId, filesTab, readOnly, small, focus }: { node: Node; results: ChatState['results']; tabId: string | null; filesTab: string | null; readOnly: boolean; small?: boolean; focus: boolean }) {
  switch (node.t) {
    case 'user':
      return <UserBubble blocks={node.blocks} />;
    case 'text':
      return <ChatMarkdown text={node.text} small={small} tabId={filesTab} />;
    case 'thinking':
      return <Thinking text={node.text} />;
    case 'image':
      return <InlineImage alt={t('chat.imageAlt')} src={`data:${node.mediaType};base64,${node.base64}`} className="max-h-72 rounded-md" />;
    case 'tools':
      return focus ? <FocusedTools tools={node.tools} results={results} /> : <ToolGroup tools={node.tools} results={results} />;
    case 'subagent':
      return <Subagent id={node.id} tools={node.tools} results={results} />;
    case 'request':
      return <RequestCard item={node.item} tabId={readOnly ? null : tabId} />;
    case 'result': {
      const it = node.item;
      if (it.error) return <div role="alert" className="selectable rounded-md border border-accent-deep bg-accent-bg px-3 py-2 text-xs wrap-anywhere text-soft">{t('chat.turnError', { error: it.error })}</div>;
      if (it.interrupted) return <div className="font-mono text-[11px] text-dim">{t('chat.turnInterrupted')}</div>;
      const sum = tokenSum(it.usage);
      if (sum === 0) return null;
      return (
        <div className="text-[11px] text-dim/80" title={t('chat.usageTitle', { input: it.usage.input, output: it.usage.output, write: it.usage.cacheWrite, read: it.usage.cacheRead })}>
          {t('chat.tokens', { n: fmtTokens(sum) })}{it.costUsd != null && <CostPart usd={it.costUsd} />}
        </div>
      );
    }
    case 'terminal':
      return <TerminalScreen item={node.item} />;
    case 'notice':
      return (
        <div role={node.item.level === 'error' ? 'alert' : undefined} className={cn('selectable rounded-md px-3 py-2 text-xs wrap-anywhere whitespace-pre-wrap', node.item.level === 'error' ? 'border border-accent-deep bg-accent-bg text-soft' : 'border border-line text-muted')}>
          {node.item.text}
        </div>
      );
  }
});

const PAGE = 200;
const NEAR_PX = 60;
const BACK_PX = 24; // this far down in one go is coming back to the bottom; less is a touchpad's jitter

/**
 * Follows the bottom like a terminal until the user scrolls up, then keeps their place. It goes by the direction of the
 * scroll, not by the distance to the bottom alone: a wheel tick is often smaller than NEAR_PX, and the next line of a stream
 * would throw that user straight back down. The input lets go before the scroll: an animated wheel moves less than a pixel in
 * its first frame, and a stick in that frame would cancel the animation. Only the user's own way down follows again:
 * a picture loading above the place moves scrollTop too, and the distance to the bottom stays.
 */
function useStickToBottom(deps: { scrollKey: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const seen = useRef({ top: 0, height: 0, client: 0 }); // the place the next scroll event is compared with
  const down = useRef(0); // how far the place has gone down since it last went up

  const look = (el: HTMLElement) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight });
  const gap = (s: { top: number; height: number; client: number }) => s.height - s.top - s.client;
  const stick = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    // At once, not with its scroll event: a wheel tick landing before that event would look like a move down from the old place.
    seen.current = look(el);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) stick(el);
    pinned.current = true;
    setAtBottom(true);
  }, [deps.scrollKey]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!pinned.current && gap(look(el)) <= 1) pinned.current = true; // nothing is left below the place
      if (pinned.current) stick(el);
      else seen.current = look(el);
      setAtBottom(pinned.current);
    });
    ro.observe(inner);
    ro.observe(el); // the field under the chat grows, a strip of subagents appears
    const onScroll = () => {
      const last = seen.current;
      const now = look(el);
      if (now.top === last.top && now.height === last.height && now.client === last.client) return; // the event of a stick
      seen.current = now;
      const closer = gap(last) - gap(now);
      // Content that shrank or a taller viewport also lowers scrollTop, but they leave the place at the very bottom.
      if (now.top < last.top - 0.5 && gap(now) > 1) {
        pinned.current = false;
        down.current = 0;
      } else if (closer > 0) {
        if (now.top > last.top) down.current += closer;
        if (gap(now) <= 1 || (gap(now) < NEAR_PX && down.current >= BACK_PX)) pinned.current = true;
      }
      setAtBottom(pinned.current);
    };
    const letGo = () => {
      if (!pinned.current || el.scrollHeight <= el.clientHeight) return;
      pinned.current = false;
      down.current = 0;
      setAtBottom(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // zoom
      if (e.deltaY < 0) letGo();
      else if (e.deltaY > 0 && !pinned.current && gap(look(el)) <= 1) {
        pinned.current = true; // already at the bottom: no scroll event will say so
        setAtBottom(true);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') letGo();
    };
    // Opening a card at the bottom keeps the card under the pointer: following would pull it away. Closing it follows again, see the observer.
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[aria-expanded]')) return;
      pinned.current = false;
      down.current = 0;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    inner.addEventListener('click', onClick, true);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      inner.removeEventListener('click', onClick, true);
    };
  }, []);

  const toBottom = () => {
    const el = scroller.current;
    if (el) stick(el);
    pinned.current = true;
    setAtBottom(true);
  };
  return { scroller, content, atBottom, toBottom };
}

export function Transcript({
  chat,
  tabId,
  filesTab = tabId,
  sessionId,
  scrollKey,
  readOnly = false,
  working,
  empty,
  small,
  className,
}: {
  chat: ChatState;
  tabId: string | null;
  filesTab?: string | null; // whose files the paths in the text mean: a read-only view has a tab too, just no way to write into it
  sessionId?: string | null;
  scrollKey: string | null;
  readOnly?: boolean;
  working?: boolean;
  empty?: ReactNode;
  small?: boolean;
  className?: string;
}) {
  const { nodes, inner } = useMemo(() => flatten(chat.items, readOnly), [chat.items, readOnly]);
  const toolContext = useMemo(() => ({ sessionId: sessionId ?? null, filesTab, inner, tasks: chat.tasks }), [sessionId, filesTab, inner, chat.tasks]);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [scrollKey]);
  const { scroller, content, atBottom, toBottom } = useStickToBottom({ scrollKey });

  // Someone reading further up keeps the top of the page: a new message must not take away what is above their place.
  const kept = useRef<number | null>(null);
  const trimmed = Math.max(0, nodes.length - limit);
  const hidden = atBottom ? trimmed : Math.min(kept.current ?? trimmed, trimmed);
  kept.current = atBottom ? null : hidden;
  const page = hidden > 0 ? nodes.slice(hidden) : nodes;
  const focus = useFocusMode((s) => s.on);
  const width = useChatWidthClass();
  // Reasoning and token counters go; a failed or interrupted turn is part of the conversation and stays.
  const visible = focus ? page.filter((n) => n.t !== 'thinking' && !(n.t === 'result' && !n.item.error && !n.item.interrupted)) : page;
  const streams = chat.streamOrder.map((id) => chat.stream[id]).filter(Boolean);
  const isEmpty = nodes.length === 0 && streams.length === 0;

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div ref={scroller} data-testid="transcript-scroller" className="transcript-scroller absolute inset-0 overflow-auto">
        <div ref={content} className={cn('mx-auto flex w-full flex-col gap-4.5', width, small ? 'p-3' : 'px-5 py-6', focus && '[&_pre]:max-h-48 [&_pre]:overflow-auto')}>
          {hidden > 0 && (
            <Button size="sm" variant="ghost" className="self-center" onClick={() => setLimit((l) => l + PAGE)}>
              {t('chat.showMore', { n: hidden })}
            </Button>
          )}
          {isEmpty && empty}
          <ToolContext.Provider value={toolContext}>
            {visible.map((n) => (
              <div key={n.key} className="msg-item">
                <NodeView node={n} results={n.t === 'tools' || n.t === 'subagent' ? chat.results : emptyResults} tabId={tabId} filesTab={filesTab} readOnly={readOnly} small={small} focus={focus} />
              </div>
            ))}
          </ToolContext.Provider>
          {streams.map((text, i) => (
            <ChatMarkdown key={i} text={text} small={small} tabId={filesTab} images={false} />
          ))}
          {working && (
            // Sticky: the only way to stop a turn stays in reach when the conversation is scrolled up.
            <div role="status" className="enter-fade sticky bottom-2 flex h-7 w-fit items-center gap-2 rounded-full border border-line2 bg-card pr-1 pl-2.5 text-xs text-muted shadow-md">
              <i className="dot-working block size-1.5 rounded-full bg-accent" />
              {t('chat.working')}
              {tabId && !readOnly && (
                <button
                  type="button"
                  aria-label={t('composer.interrupt')}
                  title={t('composer.interrupt')}
                  onClick={() => api(`/api/tabs/${encodeURIComponent(tabId)}/interrupt`, { method: 'POST' }).catch(toastError)}
                  className="press flex h-5 items-center gap-1 rounded-full bg-accent-bg px-2 text-[11px] font-medium text-accent hover:bg-accent hover:text-on-accent"
                >
                  <Square size={8} fill="currentColor" />
                  {t('composer.stop')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          aria-label={t('chat.toBottom')}
          onClick={toBottom}
          className="enter-fade press absolute right-4 bottom-3 flex size-8 items-center justify-center rounded-full border border-line bg-card text-muted shadow-lg hover:text-fg"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}

const emptyResults: ChatState['results'] = {};
