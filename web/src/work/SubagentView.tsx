import { create } from 'zustand';
import { useMemo } from 'react';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import { Dialog } from '@/components/ui';
import { useApi } from '@/lib/api';
import { applyEvents, emptyChat, useChat } from '@/lib/chat';
import { fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { SubagentTranscript, Tab } from '@/lib/types';
import { Transcript } from './Transcript';

const ACTIVE_MS = 30_000; // no status for a subagent exists in its journal: a file that just changed is at work

export function journalActive(lastActivity: number | null): boolean {
  return lastActivity != null && Date.now() - lastActivity < ACTIVE_MS;
}

export interface SubagentTarget {
  sessionId: string;
  key: string; // agent id or the id of the call that started it
  title: string | null;
  fallback?: string | null; // the call's own text, when the journal is not there (yet)
}

export const useSubagentView = create<{ target: SubagentTarget | null; open(target: SubagentTarget | null): void }>((set) => ({
  target: null,
  open: (target) => set({ target }),
}));

function Inside({ target }: { target: SubagentTarget }) {
  const data = useApi<SubagentTranscript>(`/api/sessions/${encodeURIComponent(target.sessionId)}/subagents/${encodeURIComponent(target.key)}`, ['sessions']);
  // Sessions of this app report the task's state; for the others only the journal's age is known.
  const task = useChat((s) => {
    for (const c of Object.values(s.tabs)) {
      for (const x of Object.values(c.tasks)) if (x.id === target.key || x.toolUseId === target.key) return x;
    }
    return undefined;
  });
  const chat = useMemo(() => (data.data ? applyEvents(emptyChat(), data.data.events) : null), [data.data]);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const filesTab = tabs.data?.find((x) => x.sessionId === target.sessionId)?.id ?? null;
  if (!data.data) {
    if (data.error) {
      if (!target.fallback) return <div className="p-4"><ErrorState message={t('subagent.noJournal')} onRetry={data.refetch} /></div>;
      return (
        <div className="selectable overflow-auto p-4 text-xs whitespace-pre-wrap text-muted">
          <p className="mb-2 text-dim">{t('subagent.noJournal')}</p>
          {target.fallback}
        </div>
      );
    }
    return <div className="p-4"><Skeleton lines={6} /></div>;
  }
  const active = task ? task.status === 'running' : !data.data.finished && journalActive(data.data.lastActivity);
  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-line2 px-4 py-1.5 text-[11px] text-dim">
        <span className="text-muted">{data.data.agentType ?? t('side.agent')}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{data.data.id}</span>
        {active && <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" />}
        <span className="flex-none">{active ? t('subagent.active') : fmtAgo(data.data.lastActivity)}</span>
      </div>
      <Transcript
        chat={chat ?? emptyChat()}
        tabId={null}
        sessionId={target.sessionId}
        filesTab={filesTab}
        scrollKey={data.data.id}
        readOnly
        small
        empty={<Empty>{t('subagent.empty')}</Empty>}
      />
    </>
  );
}

export function SubagentDialog() {
  const target = useSubagentView((s) => s.target);
  const open = useSubagentView((s) => s.open);
  return (
    <Dialog open={target !== null} onOpenChange={(v) => { if (!v) open(null); }} title={target?.title || t('subagent.title')} width={860}>
      {target && <div className="flex h-[70vh] min-h-0 flex-col"><Inside target={target} /></div>}
    </Dialog>
  );
}
