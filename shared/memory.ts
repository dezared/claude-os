// Memory at wiki scale (tens of thousands of notes per project): the map gets a representative subset with the
// full counts, the Storage panel gets per-project figures and a paged, filtered list of every note.
import type { MemoryGraph } from './contract.ts';

export interface MemoryCount { project: string | null; notes: number }

// GET /api/memory/graph. `nodes` is at most MEMORY_MAP_CAP notes (hubs, recent, linked) per project share;
// `total` and `counts` are the whole vault, so a count shown next to the map is never the subset's.
export type MemoryMap = MemoryGraph & { total: number; counts: MemoryCount[] };

export const MEMORY_MAP_CAP = 1500;

// What the Storage panel can filter notes by; a note may be several at once.
export const MEMORY_HEALTH = ['malformed', 'broken', 'duplicate', 'orphan'] as const;
export type MemoryHealth = (typeof MEMORY_HEALTH)[number];

export interface MemoryProjectStats {
  project: string | null; // null: global notes
  notes: number;
  outside: number; // read-only notes in the old place, not in the vault
  added7: number; // notes changed in the last 7 days (metadata.modified, else mtime)
  added30: number;
  weeks: number[]; // notes changed per week, the last MEMORY_WEEKS weeks, oldest first
  types: Record<string, number>; // metadata.type, '' for none
  tags: [string, number][]; // most used first, at most 12
  health: Record<MemoryHealth, number>;
}

export const MEMORY_WEEKS = 12;

// GET /api/memory/overview
export interface MemoryOverview { total: number; projects: MemoryProjectStats[] }

export interface MemoryNoteRow {
  id: string; // MemoryNode.id
  name: string;
  project: string | null;
  connected: boolean;
  type: string | null;
  tags: string[];
  summary: string | null;
  mtime: number; // metadata.modified, else the file's
  health: MemoryHealth[];
  snippet: string | null; // with a query: highlights as in MemorySearchHit
}

// GET /api/memory/list?q=&project=&type=&tag=&health=&offset=&limit=  (limit default 50, max 200; a query ranks
// by relevance and sees the best MEMORY_LIST_MATCHES hits, without one the newest come first)
export interface MemoryNoteList { total: number; rows: MemoryNoteRow[] }

export const MEMORY_LIST_MATCHES = 1000;
