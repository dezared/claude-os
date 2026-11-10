import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { cn, fmtTokens } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { ActiveSubagent, TaskInfo } from '@/lib/types';
import { useSubagentView } from './SubagentView';

const POLL_MS = 2500; // the topic alone is too slow: the journal index commits in batches and "what it does now" moves faster
const noTasks: Record<string, TaskInfo> = {};

interface Row {
  key: string;
  agentType: string | null;
  description: string | null;
  doing: string | null;
  startedAt: number | null;
  tokens: number | null;
}

// A session of this app reports its tasks, what ended is known at once. A journal adds what a task does not say: the arguments and the start.
export function activeRows(journal: ActiveSubagent[], tasks: Record<string, TaskInfo>): Row[] {
  const known = Object.values(tasks);
  const rows: Row[] = [];
  for (const x of known) {
    if (x.status !== 'running' || (x.type !== 'local_agent' && x.agentType === null)) continue;
    const j = journal.find((a) => a.id === x.id || (x.toolUseId !== null && a.toolUseId === x.toolUseId));
    rows.push({ key: x.id, agentType: x.agentType ?? j?.agentType ?? null, description: x.description || j?.description || null, doing: j?.doing ?? x.lastTool, startedAt: j?.startedAt ?? null, tokens: x.tokens });
  }
  for (const a of journal) {
    if (known.some((x) => x.id === a.id || (x.toolUseId !== null && x.toolUseId === a.toolUseId))) continue;
    rows.push({ key: a.id, agentType: a.agentType, description: a.description, doing: a.doing, startedAt: a.startedAt, tokens: null });
  }
  return rows;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** What is running right next to the input, as in Claude Code. Works for any session: the journal on disk is enough. */
export function SubagentStrip({ sessionId, tasks = noTasks, enabled = true, className }: { sessionId: string | null | undefined; tasks?: Record<string, TaskInfo>; enabled?: boolean; className?: string }) {
  const on = enabled && !!sessionId;
  const query = useApi<ActiveSubagent[]>(on ? `/api/sessions/${encodeURIComponent(sessionId!)}/subagents` : null, ['sessions']);
  const { refetch } = query;
  useEffect(() => {
    if (!on) return;
    refetch();
    const timer = setInterval(() => {
      if (!document.hidden) refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [on, refetch]);

  const open = useSubagentView((s) => s.open);
  const rows = on ? activeRows(query.data ?? [], tasks) : [];
  const running = rows.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!running || !sessionId) return null;
  return (
    <div role="group" aria-label={t('subagent.stripAria')} className={cn('subagent-strip enter-fade flex max-h-24 flex-col overflow-auto rounded-lg border border-line2 bg-card py-0.5', className)}>
      {rows.map((r) => (
        <button
          key={r.key}
          type="button"
          title={t('subagent.open')}
          onClick={() => open({ sessionId, key: r.key, title: r.description })}
          className="press flex w-full min-w-0 flex-none items-center gap-2 px-2.5 py-0.5 text-left text-[11.5px] hover:bg-raised"
        >
          <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" />
          <Bot size={11} className="flex-none text-dim" />
          <span className="flex-none text-muted">{r.agentType ?? t('side.agent')}</span>
          {r.description && <span className="max-w-[40%] min-w-0 flex-none truncate text-soft">{r.description}</span>}
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">{r.doing}</span>
          {r.tokens != null && <span className="flex-none text-[10.5px] text-dim">{fmtTokens(r.tokens)}</span>}
          {r.startedAt != null && <span className="flex-none font-mono text-[10.5px] text-dim tabular-nums">{elapsed(now - r.startedAt)}</span>}
        </button>
      ))}
    </div>
  );
}
