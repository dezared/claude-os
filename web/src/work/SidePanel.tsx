import { Activity, Bot, CircleHelp, Coins, FolderCog, History, ScrollText, Sparkle } from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Empty, Skeleton } from '@/components/states';
import { Segmented, SectionTitle } from '@/components/ui';
import { useShowCost } from '@/lib/account';
import { useApi } from '@/lib/api';
import type { ChatState } from '@/lib/chat';
import { fmtAgo, fmtDateTime, fmtInt, fmtTokens, fmtUsd } from '@/lib/format';
import { useApp } from '@/lib/store';
import type { MemoryGraph, SessionInfo, Tab, TokenCounts, UsageEntry } from '@/lib/types';
import { t } from '@/lib/i18n';
import { journalActive, useSubagentView } from './SubagentView';
import { useTabCommand } from './tabCommands';
import { isAgentTool, toolSummary, type ToolBlock } from './ToolCall';

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <small className="block text-[11px] text-dim">{label}</small>
      <b className="text-[15px] font-medium" title={fmtInt(value)}>{value >= 1e6 ? fmtTokens(value) : fmtInt(value)}</b>
    </div>
  );
}

const ProjectSetupPanel = lazy(() => import('./ProjectSetupPanel').then((m) => ({ default: m.ProjectSetupPanel })));

/** Skills and memory this session really touched, by tool calls in its journal. */
function SessionUsage({ sessionId, graph }: { sessionId: string | null; graph: MemoryGraph | undefined }) {
  const log = useApi<UsageEntry[]>(sessionId ? `/api/usage-log?session=${encodeURIComponent(sessionId)}&limit=500` : null, ['usage']);
  const openNote = useApp((s) => s.openNote);
  const grouped = new Map<string, { e: UsageEntry; n: number }>();
  for (const e of log.data ?? []) {
    const hit = grouped.get(`${e.kind}${e.target}${e.op}`);
    if (hit) hit.n++;
    else grouped.set(`${e.kind}${e.target}${e.op}`, { e, n: 1 });
  }
  const rows = [...grouped.values()];
  return (
    <section>
      <SectionTitle icon={ScrollText} aside={rows.length || undefined}>{t('side.used')}</SectionTitle>
      {rows.length === 0 ? <Empty>{t('side.usedNone')}</Empty> : rows.slice(0, 30).map(({ e, n }) => {
        const file = e.target.split('/').at(-1) ?? e.target;
        const node = e.kind === 'skill' ? undefined : graph?.nodes.find((x) => x.file === file && (e.kind === 'vault' ? x.connected : !x.connected));
        return (
          <div key={`${e.kind}${e.target}${e.op}`} className="flex items-baseline gap-2 py-0.5 text-[12px]" title={e.target}>
            {node ? <button type="button" onClick={() => openNote(node.id)} className="press min-w-0 flex-1 truncate text-left text-soft hover:text-accent">{file}</button> : <span className="min-w-0 flex-1 truncate text-soft">{file}</span>}
            <span className="flex-none text-[11px] text-dim">{e.kind === 'skill' ? t('side.usedSkill') : e.op === 'write' ? t('side.usedWrite') : t('side.usedRead')}{n > 1 ? ` ×${n}` : ''}</span>
          </div>
        );
      })}
      <p className="mt-1 text-[11px] leading-[1.4] text-dim">{t('side.usedNote')}</p>
    </section>
  );
}

const RUNNING_SCAN = 300;

/** Commands and tools without a result yet, and live tasks. Subagents open into their own view. */
function NowRunning({ chat, sessionId, working }: { chat: ChatState; sessionId: string | null; working: boolean }) {
  const openView = useSubagentView((s) => s.open);
  const calls = useMemo(() => {
    if (!working) return [];
    const out: ToolBlock[] = [];
    for (const item of chat.items.slice(-RUNNING_SCAN)) {
      if (item.k !== 'assistant') continue;
      for (const b of item.blocks) if (b.type === 'tool_use' && !chat.results[b.id] && !isAgentTool(b.name)) out.push(b);
    }
    return out;
  }, [chat.items, chat.results, working]);
  const tasks = Object.values(chat.tasks).filter((x) => x.status === 'running');
  // The CLI runs a long command as a task too: one line for it, with the command itself.
  const commands = calls.filter((b) => !tasks.some((x) => x.toolUseId === b.id && x.type !== 'local_bash'));
  const rest = tasks.filter((x) => !commands.some((b) => b.id === x.toolUseId));
  if (commands.length === 0 && rest.length === 0) return null;
  return (
    <section aria-label={t('side.running')}>
      <SectionTitle icon={Activity} aside={commands.length + rest.length}>{t('side.running')}</SectionTitle>
      {rest.map((x) => {
        const agent = x.type === 'local_agent' || x.agentType !== null;
        const body = (
          <>
            {agent ? <Bot size={11} className="flex-none text-dim" /> : <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" />}
            <span className="min-w-0 flex-1 truncate text-[12px] text-soft">{x.description}</span>
            {x.tokens != null && <span className="flex-none text-[11px] text-dim">{fmtTokens(x.tokens)}</span>}
          </>
        );
        return agent && sessionId ? (
          <button key={x.id} type="button" title={t('subagent.open')} onClick={() => openView({ sessionId, key: x.toolUseId ?? x.id, title: x.description })} className="press -mx-2 flex w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised">{body}</button>
        ) : (
          <div key={x.id} className="flex items-center gap-2 py-1" title={x.description}>{body}</div>
        );
      })}
      {commands.slice(-8).map((b) => (
        <div key={b.id} className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-dim" title={toolSummary(b.name, b.input)}>
          <i className="dot-working block size-1 flex-none rounded-full bg-accent" />
          <span className="flex-none text-muted">{b.name}</span>
          <span className="min-w-0 truncate">{toolSummary(b.name, b.input)}</span>
        </div>
      ))}
    </section>
  );
}

export function SidePanel({ tab, chat }: { tab: Tab; chat: ChatState }) {
  const [pane, setPane] = useState<'session' | 'project'>('session');
  const aside = useRef<HTMLElement>(null);
  useTabCommand(tab.id, 'running', () => {
    setPane('session');
    aside.current?.scrollTo({ top: 0 }); // what is running stands first
    aside.current?.scrollIntoView({ block: 'nearest' }); // under the chat on a narrow window
  });
  return (
    <aside ref={aside} data-testid="side-panel" className="flex flex-col gap-3 overflow-auto p-4">
      {tab.project && (
        <div className="flex-none">
          <Segmented
            ariaLabel={t('side.paneAria')}
            value={pane}
            onChange={setPane}
            options={[
              { value: 'session', label: t('side.paneSession'), icon: History },
              { value: 'project', label: t('side.paneProject'), icon: FolderCog },
            ]}
          />
        </div>
      )}
      {pane === 'project' && tab.project ? (
        <Suspense fallback={<Skeleton lines={6} />}><ProjectSetupPanel project={tab.project} /></Suspense>
      ) : (
        <SessionPane tab={tab} chat={chat} />
      )}
    </aside>
  );
}

const AGENTS_SHOWN = 10;

function SessionPane({ tab, chat }: { tab: Tab; chat: ChatState }) {
  const sessions = useApi<SessionInfo[]>('/api/sessions', ['sessions']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const openNote = useApp((s) => s.openNote);
  const showCost = useShowCost();
  const sessionId = chat.sessionId ?? tab.sessionId;
  const session = sessions.data?.find((s) => s.id === sessionId);
  const usage: TokenCounts = session?.tokens ?? chat.usage;
  const hasUsage = usage.input + usage.output + usage.cacheWrite + usage.cacheRead > 0;
  const agents = session?.subagents ?? [];
  const [allAgents, setAllAgents] = useState(false);
  const openView = useSubagentView((s) => s.open);
  const notes = tab.project ? (graph.data?.nodes ?? []).filter((n) => n.project === tab.project).sort((a, b) => b.mtime - a.mtime) : [];

  return (
    <div className="flex flex-col gap-5.5">
      <NowRunning chat={chat} sessionId={sessionId} working={(chat.status ?? tab.status) === 'working' || tab.status === 'working'} />
      <section>
        <SectionTitle icon={Coins}>
          {t('side.tokens')}
          {hasUsage && (
            <span
              role="img"
              tabIndex={0}
              aria-label={t('side.tokensUpdatedAria')}
              title={session?.lastActivity != null ? t('side.tokensUpdated', { at: fmtDateTime(session.lastActivity), ago: fmtAgo(session.lastActivity) }) : t('side.tokensLive')}
              className="cursor-help rounded-full text-dim transition-colors duration-150 hover:text-soft"
            >
              <CircleHelp size={11} className="translate-y-px" />
            </span>
          )}
        </SectionTitle>
        {hasUsage ? (
          <>
            <div className="grid grid-cols-2 gap-x-2 gap-y-3">
              <Tile label={t('side.input')} value={usage.input} />
              <Tile label={t('side.output')} value={usage.output} />
              <Tile label={t('side.cacheRead')} value={usage.cacheRead} />
              <Tile label={t('side.cacheWrite')} value={usage.cacheWrite} />
            </div>
            {showCost && chat.costUsd != null && (
              <p className="mt-2 text-[11px] text-dim">
                {t('side.costNote', { cost: fmtUsd(chat.costUsd) })}
              </p>
            )}
          </>
        ) : (
          <Empty>{t('side.noTokens')}</Empty>
        )}
      </section>

      <section>
        <SectionTitle icon={Bot} aside={agents.length || undefined}>{t('side.agents')}</SectionTitle>
        {agents.length === 0 ? (
          <Empty>{t('side.noAgents')}</Empty>
        ) : (
          (allAgents ? agents : agents.slice(0, AGENTS_SHOWN)).map((a) => (
            <button key={a.id} type="button" title={t('subagent.open')} onClick={() => sessionId && openView({ sessionId, key: a.id, title: a.description })} className="press -mx-2 mb-1 block w-[calc(100%+16px)] rounded-md px-2 py-1 text-left hover:bg-raised">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{a.agentType ?? t('side.agent')}</span>
                {journalActive(a.lastActivity) && <i className="dot-working mb-px block size-1.5 flex-none self-center rounded-full bg-accent" title={t('subagent.active')} />}
                <span className="text-[11.5px] text-dim">{fmtTokens(a.tokens)} · {fmtAgo(a.lastActivity)}</span>
              </span>
              {a.description && <span className="block truncate text-xs text-dim">{a.description}</span>}
            </button>
          ))
        )}
        {agents.length > AGENTS_SHOWN && (
          <button type="button" onClick={() => setAllAgents((v) => !v)} className="press mt-1 text-[11px] text-dim hover:text-soft">
            {allAgents ? t('side.agentsFewer') : t('side.agentsAll', { n: fmtInt(agents.length) })}
          </button>
        )}
      </section>

      <SessionUsage sessionId={sessionId} graph={graph.data} />

      <section>
        <SectionTitle icon={Sparkle} aside={notes.length || undefined}>{t('side.memory')}</SectionTitle>
        {!graph.data && !graph.error && <Skeleton lines={2} />}
        {graph.error && !graph.data && <Empty>{t('side.memoryFailed', { error: graph.error })}</Empty>}
        {graph.data && notes.length === 0 && <Empty>{t('side.noNotes')}</Empty>}
        {notes.slice(0, 12).map((n) => (
          <button key={n.id} type="button" onClick={() => openNote(n.id)} title={n.title} className="press -mx-2 flex w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-soft">{n.title}</span>
            <span className="text-[11px] text-dim">{fmtAgo(n.mtime)}</span>
          </button>
        ))}
        {notes.length > 12 && <p className="mt-1 text-[11px] text-dim">{t('side.moreNotes', { n: fmtInt(notes.length - 12) })}</p>}
      </section>
    </div>
  );
}
