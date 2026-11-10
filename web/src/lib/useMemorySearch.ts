import { createElement, Fragment, useEffect, useState, type ReactNode } from 'react';
import { useApi } from './api';
import type { MemorySearchHit } from './types';

const DEBOUNCE_MS = 150;
const OPEN = '\u0001';
const CLOSE = '\u0002';

/** Notes found by the server's full-text search. Null under 2 chars; the previous hits stay while the next query travels. */
export function useMemorySearch(q: string, limit: number): MemorySearchHit[] | null {
  const query = q.trim();
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const ready = query.length >= 2 && settled.length >= 2;
  const path = ready ? `/api/memory/search?q=${encodeURIComponent(settled)}&limit=${limit}` : null;
  const data = useApi<MemorySearchHit[]>(path, ['memory']).data;
  const [shown, setShown] = useState<MemorySearchHit[] | null>(null);
  useEffect(() => {
    if (!ready) setShown(null);
    else if (data) setShown(data);
  }, [ready, data]);
  return ready ? (data ?? shown) : null;
}

/** A search snippet with its marked words as <mark>: the markers are control chars, so the note's text is never parsed as HTML. */
export function Snippet({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  text.split(OPEN).forEach((chunk, i) => {
    const end = chunk.indexOf(CLOSE);
    const marked = i === 0 ? '' : end < 0 ? chunk : chunk.slice(0, end);
    const plain = i === 0 ? chunk : end < 0 ? '' : chunk.slice(end + 1);
    if (marked) parts.push(createElement('mark', { key: i, className: 'rounded-sm bg-accent-bg text-fg' }, marked));
    if (plain) parts.push(createElement(Fragment, { key: `${i}t` }, plain.replaceAll(CLOSE, '')));
  });
  return parts;
}
