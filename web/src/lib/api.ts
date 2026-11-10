import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { serverText, t, type Key } from './i18n';
import { useApp } from './store';
import type { Topic } from './types';

export class ApiError extends Error {
  status: number;
  /** The parsed error body: some errors carry fields beyond `error`. */
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const humanStatus: Record<number, Key> = { 403: 'api.403', 404: 'api.404', 409: 'api.409', 500: 'api.500', 501: 'api.501', 503: 'api.503' };

/** While still 'connecting' (the socket never opened) the socket's own retries decide when the server counts as gone. */
function markOffline() {
  const app = useApp.getState();
  if (app.connection !== 'connecting') app.setConnection('offline');
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    markOffline();
    throw new ApiError(0, t('api.offline'));
  }
  if (res.status === 401) {
    useApp.getState().setUnauthorized();
    throw new ApiError(401, t('api.unauthorized'));
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError(res.status, t('api.notJson'));
  }
  if (!res.ok) {
    const body = parsed as { error?: string; key?: string; params?: Record<string, string | number> } | null;
    const msg = typeof body?.error === 'string' ? serverText(body.error, body.key, body.params) : humanStatus[res.status] ? t(humanStatus[res.status]) : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

// ---------- Shared query cache, refetched by WebSocket topics ----------

interface Entry {
  data: unknown;
  error: string | null;
  loading: boolean;
  topics: Topic[];
  subs: Set<() => void>;
  stale: boolean;
  inflight: boolean;
  queuedRefetch: boolean;
  edits: number; // local changes through setCached
  attempts: number;
  snapshot: { data: unknown; error: string | null; loading: boolean };
}

const cache = new Map<string, Entry>();
const STARTUP_ATTEMPTS = 3; // failed loads before the error shows, while nothing has loaded yet

function entryFor(path: string, topics: Topic[]): Entry {
  let e = cache.get(path);
  if (!e) {
    e = {
      data: undefined,
      error: null,
      loading: true,
      topics,
      subs: new Set(),
      stale: true,
      inflight: false,
      queuedRefetch: false,
      edits: 0,
      attempts: 0,
      snapshot: { data: undefined, error: null, loading: true },
    };
    cache.set(path, e);
  }
  return e;
}

function publish(e: Entry) {
  e.snapshot = { data: e.data, error: e.error, loading: e.loading };
  e.subs.forEach((s) => s());
}

async function load(path: string, e: Entry) {
  if (e.inflight) {
    e.queuedRefetch = true;
    return;
  }
  e.inflight = true;
  e.stale = false;
  const edits = e.edits;
  try {
    const data = await api(path);
    // The screen changed while this answer travelled: it is older than what is shown, so it is asked again.
    if (e.edits !== edits) e.queuedRefetch = true;
    else e.data = data;
    e.error = null;
    e.attempts = 0;
  } catch (err) {
    e.error = (err as Error).message;
    // Nothing on screen yet and the server may still be starting: keep trying instead of waiting for a click.
    if (e.data === undefined && e.subs.size > 0 && !(err instanceof ApiError && err.status >= 400 && err.status < 500)) {
      setTimeout(() => void load(path, e), Math.min(8000, 500 * 2 ** e.attempts++));
      // The first misses read as loading: an error that a retry fixes half a second later is only a flash.
      if (e.attempts < STARTUP_ATTEMPTS) e.error = null;
    }
  }
  e.loading = e.data === undefined && e.error === null && e.attempts > 0;
  e.inflight = false;
  publish(e);
  if (e.queuedRefetch) {
    e.queuedRefetch = false;
    void load(path, e);
  }
}

export function invalidateTopics(topics: Topic[]) {
  for (const [path, e] of cache) {
    if (!e.topics.some((t) => topics.includes(t))) continue;
    if (e.subs.size > 0) void load(path, e);
    else e.stale = true;
  }
}

/** After a reconnect anything may have changed. */
export function invalidateAll() {
  for (const [path, e] of cache) {
    if (e.subs.size > 0) void load(path, e);
    else e.stale = true;
  }
}

export function peekCached<T>(path: string): T | undefined {
  return cache.get(path)?.data as T | undefined;
}

export function setCached<T>(path: string, update: (old: T | undefined) => T) {
  const e = cache.get(path);
  if (!e) return;
  e.data = update(e.data as T | undefined);
  e.edits++;
  publish(e);
}

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  /** Nothing to show yet. A refetch keeps the previous data and stays false. */
  loading: boolean;
  refetch: () => void;
}

const emptySnapshot = { data: undefined, error: null, loading: false };

export function useApi<T>(path: string | null, topics: Topic[] = []): Query<T> {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!path) return () => {};
      const e = entryFor(path, topics);
      e.subs.add(cb);
      return () => e.subs.delete(cb);
    },
    // Topics are constant per path at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path],
  );
  const snap = useSyncExternalStore(subscribe, () => (path ? entryFor(path, topics).snapshot : emptySnapshot));

  useEffect(() => {
    if (!path) return;
    const e = entryFor(path, topics);
    if (e.stale) void load(path, e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const refetch = useCallback(() => {
    if (path) void load(path, entryFor(path, topics));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { data: snap.data as T | undefined, error: snap.error, loading: snap.loading, refetch };
}
