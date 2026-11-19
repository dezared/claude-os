// The Storage panel's routes: per-project figures and the list of every note, filtered and paged.
import { MEMORY_HEALTH, MEMORY_LIST_MATCHES, type MemoryHealth, type MemoryNoteList, type MemoryOverview } from '../../shared/memory.ts';
import type { Ctx } from '../context.ts';
import { listOf } from './catalog.ts';
import type { Searcher } from './noteIndex.ts';
import type { Store } from './store.ts';

const LIST_LIMIT = 50;
const LIST_MAX = 200;

type ListParams = { q?: string; project?: string; type?: string; tag?: string; health?: string; offset?: string; limit?: string };

const bounded = (raw: string | undefined, fallback: number, max: number) => {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && raw !== undefined && raw !== '' ? Math.min(max, Math.max(0, n)) : fallback;
};

export function registerStorage(ctx: Ctx, store: Store, searcher: Searcher): void {
  ctx.app.get('/api/memory/overview', async (): Promise<MemoryOverview> => store.catalog().overview);

  // `project=` (empty) means the global notes; no `project` means every project.
  ctx.app.get<{ Querystring: ListParams }>('/api/memory/list', async (req): Promise<MemoryNoteList> => {
    const p = req.query;
    const { notes, health } = store.catalog();
    const ranked = p.q?.trim() ? searcher.ranked(p.q, MEMORY_LIST_MATCHES) : null;
    return listOf(notes, health, {
      project: p.project === undefined ? undefined : p.project || null,
      type: p.type || undefined,
      tag: p.tag || undefined,
      health: (MEMORY_HEALTH as readonly string[]).includes(p.health ?? '') ? (p.health as MemoryHealth) : undefined,
      offset: bounded(p.offset, 0, Number.MAX_SAFE_INTEGER),
      limit: bounded(p.limit, LIST_LIMIT, LIST_MAX) || LIST_LIMIT,
    }, ranked);
  });
}
