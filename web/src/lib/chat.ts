import { create } from 'zustand';
import { serverText, t } from './i18n';
import type { ChatBlock, ChatEvent, SessionStatus, SlashCommand, TaskInfo, TerminalRun, TokenCounts } from './types';

export type RequestItem =
  | { k: 'request'; type: 'permission'; key: string; requestId: string; tool: string; input: unknown; diff: string | null; title: string | null; decision: string | null; at: number }
  | { k: 'request'; type: 'question'; key: string; requestId: string; questions: unknown; decision: string | null; at: number }
  | { k: 'request'; type: 'plan'; key: string; requestId: string; plan: string; decision: string | null; at: number };

export type Item =
  | { k: 'user'; key: string; blocks: ChatBlock[]; at: number }
  | { k: 'assistant'; key: string; blocks: ChatBlock[]; model: string | null; at: number }
  | RequestItem
  | { k: 'result'; key: string; usage: TokenCounts; costUsd: number | null; interrupted: boolean; error: string | null; at: number }
  | { k: 'notice'; key: string; level: 'warning' | 'error' | 'interrupted'; text: string; at: number }
  | { k: 'terminal'; key: string; command: string; screen: string; runs?: TerminalRun[]; done: boolean; error: string | null; at: number };

export interface ChatState {
  lastSeq: number;
  items: Item[];
  results: Record<string, { text: string; isError: boolean }>;
  /** Streaming text by message id, dropped when the full 'assistant' event arrives. */
  stream: Record<string, string>;
  streamOrder: string[];
  queue: { seq: number; id: string | null; blocks: ChatBlock[] }[];
  tasks: Record<string, TaskInfo>;
  status: SessionStatus | null;
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  slash: SlashCommand[];
  usage: TokenCounts;
  costUsd: number | null;
  loaded: boolean;
  error: string | null;
  /** The seq of the last 'cleared': a change of it means everything shown before is gone. */
  clearedSeq: number;
}

export const emptyChat = (): ChatState => ({
  lastSeq: 0,
  items: [],
  results: {},
  stream: {},
  streamOrder: [],
  queue: [],
  tasks: {},
  status: null,
  sessionId: null,
  model: null,
  permissionMode: null,
  slash: [],
  usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  costUsd: null,
  loaded: false,
  error: null,
  clearedSeq: 0,
});

const userText = (blocks: ChatBlock[]) =>
  blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

function addUsage(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

export function applyEvents(state: ChatState, events: ChatEvent[]): ChatState {
  const fresh = events.filter((e) => e.seq > state.lastSeq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return state;
  const s: ChatState = {
    ...state,
    items: state.items.slice(),
    results: state.results,
    stream: { ...state.stream },
    streamOrder: state.streamOrder.slice(),
    queue: state.queue.slice(),
  };
  let resultsCopied = false;
  const dropStream = (id: string) => {
    delete s.stream[id];
    s.streamOrder = s.streamOrder.filter((x) => x !== id);
  };

  for (const ev of fresh) {
    s.lastSeq = ev.seq;
    switch (ev.e) {
      case 'user': {
        if (ev.queued) {
          s.queue.push({ seq: ev.seq, id: ev.queueId ?? null, blocks: ev.blocks });
          break;
        }
        // A queued message that reaches the session leaves the visible queue.
        const text = userText(ev.blocks);
        const i = s.queue.findIndex((q) => (ev.queueId ? q.id === ev.queueId : userText(q.blocks) === text));
        if (i >= 0) s.queue.splice(i, 1);
        s.items.push({ k: 'user', key: `u${ev.seq}`, blocks: ev.blocks, at: ev.at });
        break;
      }
      case 'queue':
        s.queue = ev.items.map((q) => ({ seq: ev.seq, id: q.id, blocks: q.blocks }));
        break;
      case 'mode':
        s.permissionMode = ev.mode;
        break;
      case 'task':
        s.tasks = { ...s.tasks, [ev.task.id]: ev.task };
        break;
      case 'delta':
        if (!(ev.messageId in s.stream)) {
          s.stream[ev.messageId] = '';
          s.streamOrder.push(ev.messageId);
        }
        s.stream[ev.messageId] += ev.text;
        break;
      case 'assistant': {
        dropStream(ev.messageId);
        const key = `a${ev.messageId}`;
        // A reply of the panel itself (/rc) comes with a key: its text in the UI language.
        const blocks: ChatBlock[] = ev.key ? [{ type: 'text', text: serverText(ev.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''), ev.key, ev.params) }] : ev.blocks;
        const i = s.items.findLastIndex((x) => x.k === 'assistant' && x.key === key);
        if (i >= 0) {
          const old = s.items[i] as Extract<Item, { k: 'assistant' }>;
          s.items[i] = { ...old, blocks: [...old.blocks, ...blocks], model: ev.model ?? old.model };
        } else {
          s.items.push({ k: 'assistant', key, blocks, model: ev.model, at: ev.at });
        }
        break;
      }
      case 'tool_result':
        if (!resultsCopied) {
          s.results = { ...s.results };
          resultsCopied = true;
        }
        s.results[ev.toolUseId] = { text: ev.text, isError: ev.isError };
        break;
      case 'init':
        s.sessionId = ev.sessionId;
        s.model = ev.model;
        s.slash = ev.slashCommands;
        s.permissionMode = ev.permissionMode;
        break;
      case 'status':
        s.status = ev.status;
        break;
      case 'permission':
        s.items.push({ k: 'request', type: 'permission', key: `r${ev.requestId}`, requestId: ev.requestId, tool: ev.tool, input: ev.input, diff: ev.diff, title: ev.title, decision: null, at: ev.at });
        break;
      case 'question':
        s.items.push({ k: 'request', type: 'question', key: `r${ev.requestId}`, requestId: ev.requestId, questions: ev.questions, decision: null, at: ev.at });
        break;
      case 'plan':
        s.items.push({ k: 'request', type: 'plan', key: `r${ev.requestId}`, requestId: ev.requestId, plan: ev.plan, decision: null, at: ev.at });
        break;
      case 'resolved': {
        const i = s.items.findLastIndex((x) => x.k === 'request' && x.requestId === ev.requestId);
        if (i >= 0) s.items[i] = { ...(s.items[i] as RequestItem), decision: ev.decision };
        break;
      }
      case 'result':
        s.streamOrder.forEach((id) => delete s.stream[id]);
        s.streamOrder = [];
        s.usage = addUsage(s.usage, ev.usage);
        // A running session total, not a per-turn figure.
        if (ev.costUsd != null) s.costUsd = ev.costUsd;
        // An interrupt cancels the queue and no queued:false follows.
        if (ev.interrupted) s.queue = [];
        s.items.push({ k: 'result', key: `x${ev.seq}`, usage: ev.usage, costUsd: ev.costUsd, interrupted: ev.interrupted, error: ev.error && serverText(ev.error, ev.key, ev.params), at: ev.at });
        break;
      case 'cleared':
        s.items = [];
        s.results = {};
        resultsCopied = true;
        s.stream = {};
        s.streamOrder = [];
        s.queue = [];
        s.tasks = {};
        s.usage = emptyChat().usage;
        s.costUsd = null;
        s.clearedSeq = ev.seq;
        break;
      case 'terminal': {
        const key = `t${ev.runId}`;
        const i = s.items.findLastIndex((x) => x.key === key);
        const item = { k: 'terminal' as const, key, command: ev.command, screen: ev.screen, runs: ev.runs, done: ev.done, error: ev.error && serverText(ev.error, ev.key, ev.params), at: ev.at };
        if (i >= 0) s.items[i] = item;
        else s.items.push(item);
        break;
      }
      case 'interrupted':
        s.items.push({ k: 'notice', key: `n${ev.seq}`, level: 'interrupted', text: t('chat.serverInterrupted'), at: ev.at });
        break;
      case 'warning':
        s.items.push({ k: 'notice', key: `n${ev.seq}`, level: 'warning', text: serverText(ev.text, ev.key, ev.params), at: ev.at });
        break;
      case 'error':
        s.items.push({ k: 'notice', key: `n${ev.seq}`, level: 'error', text: serverText(ev.text, ev.key, ev.params), at: ev.at });
        break;
    }
  }
  // Streaming deltas must not change the identity of items: the whole transcript memoizes on it.
  if (s.items.length === state.items.length && s.items.every((x, i) => x === state.items[i])) s.items = state.items;
  return s;
}

export const useChat = create<{ tabs: Record<string, ChatState> }>(() => ({ tabs: {} }));

export function updateChat(tabId: string, fn: (s: ChatState) => ChatState) {
  useChat.setState((st) => ({ tabs: { ...st.tabs, [tabId]: fn(st.tabs[tabId] ?? emptyChat()) } }));
}

export function removeChat(tabId: string) {
  useChat.setState((st) => {
    const tabs = { ...st.tabs };
    delete tabs[tabId];
    return { tabs };
  });
}
