import { api, invalidateAll, invalidateTopics, setCached } from './api';
import { applyEvents, removeChat, updateChat, useChat } from './chat';
import { inPopout } from './popout';
import { useApp } from './store';
import type { ChatEvent, ClientMessage, ServerMessage, Tab, WidgetDef, WidgetValue } from './types';
import { runUiCommand } from './uiCommands';

const attached = new Set<string>();
let socket: WebSocket | null = null;
let backoff = 500;
let everOpen = false;
let startupFailures = 0;
const STARTUP_TRIES = 3;

function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// Streaming deltas arrive much faster than a frame: batch them per tab.
let buffer = new Map<string, ChatEvent[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  const batch = buffer;
  buffer = new Map();
  for (const [tabId, events] of batch) updateChat(tabId, (s) => applyEvents(s, events));
}

function onMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'chat': {
      const list = buffer.get(msg.tabId);
      if (list) list.push(msg.event);
      else buffer.set(msg.tabId, [msg.event]);
      flushTimer ??= setTimeout(flush, 30);
      break;
    }
    case 'invalidate':
      invalidateTopics(msg.topics);
      break;
    case 'widget':
      setCached<{ defs: WidgetDef[]; values: WidgetValue[] }>('/api/widgets', (old) =>
        old ? { ...old, values: [...old.values.filter((v) => v.id !== msg.value.id), msg.value] } : { defs: [], values: [msg.value] },
      );
      break;
    case 'tab_opened':
      setCached<Tab[]>('/api/tabs', (old) => [...(old ?? []).filter((t) => t.id !== msg.tab.id), msg.tab]);
      if (msg.focus && !inPopout) useApp.getState().go({ kind: 'tab', id: msg.tab.id }); // the main window hears the same message
      break;
    case 'ui':
      if (!inPopout) runUiCommand(msg.tabId, msg.command); // one notification per request, however many windows are open
      break;
  }
}

export function connectSocket() {
  const app = useApp.getState();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    backoff = 500;
    app.setConnection('online');
    if (everOpen) invalidateAll();
    everOpen = true;
    const tabs = useChat.getState().tabs;
    for (const id of attached) {
      if (tabs[id]?.error) void attachTab(id, true);
      else send({ t: 'subscribe', tabId: id, lastSeq: tabs[id]?.lastSeq ?? 0 });
    }
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)) as ServerMessage);
    } catch {
      // A malformed frame must not kill the socket.
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    // Before the first open the server may still be starting: say offline only after a few failed tries.
    if (!everOpen) startupFailures++;
    if (everOpen || startupFailures >= STARTUP_TRIES) app.setConnection('offline');
    // A refused upgrade looks like a plain close: REST tells 401 from a dead server.
    if (!opened) void api('/api/index').catch(() => {});
    setTimeout(connectSocket, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}

/** Load the history once, then follow it live. Stays subscribed so the tab keeps state in the background. */
export async function attachTab(tabId: string, retry = false) {
  if (attached.has(tabId) && !retry) return;
  attached.add(tabId);
  updateChat(tabId, (s) => ({ ...s, error: null }));
  try {
    const events = await api<ChatEvent[]>(`/api/tabs/${encodeURIComponent(tabId)}/history`);
    updateChat(tabId, (s) => ({ ...applyEvents(s, events), loaded: true, error: null }));
    send({ t: 'subscribe', tabId, lastSeq: useChat.getState().tabs[tabId]?.lastSeq ?? 0 });
  } catch (err) {
    updateChat(tabId, (s) => ({ ...s, error: (err as Error).message }));
  }
}

export function detachTab(tabId: string) {
  attached.delete(tabId);
  send({ t: 'unsubscribe', tabId });
  removeChat(tabId);
}
