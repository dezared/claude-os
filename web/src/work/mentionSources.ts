// What the @ menu offers besides the project's files. A source is a section at the top of the menu: arrows and Space open
// it, then typing searches inside it. To add one, write a MentionSource and call addMentionSource; Composer needs no change.
import { Library, SquareKanban, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { Key } from '@/lib/i18n';
import type { DocumentInfo, KanbanCard, KanbanColumn } from '@/lib/types';
import { mentionFor } from '@/notes/mention';

export interface MentionItem {
  id: string; // short and searchable, shown in mono: OS-21
  label: string;
  hint?: string;
  mention: string; // what goes into the text, with its @
}

export interface MentionSource {
  id: string;
  label: Key;
  icon: LucideIcon;
  /** `project`: the tab's own. What belongs to it comes first. */
  search(query: string, project: string | null): Promise<MentionItem[]>;
}

export type MentionRow =
  | { kind: 'section'; source: MentionSource }
  | { kind: 'item'; source: MentionSource; item: MentionItem }
  | { kind: 'file'; path: string };

const PREVIEW = 5; // items of a source shown right in the menu when typing without opening it
const MAX_ITEMS = 30;
const MAX_FILES = 20;

const COLUMN_ORDER: Record<KanbanColumn, number> = { doing: 0, polish: 1, todo: 2, backlog: 3, done: 4 };

/** Own project first, then how well it matches, then what is alive on the board. */
export function rankCards(cards: KanbanCard[], query: string, project: string | null): KanbanCard[] {
  const q = query.trim().toLowerCase();
  const match = (c: KanbanCard) => {
    if (!q) return 0;
    const id = c.id.toLowerCase();
    if (id === q) return 0;
    if (id.startsWith(q)) return 1;
    if (id.includes(q)) return 2;
    const title = c.title.toLowerCase();
    if (title.startsWith(q)) return 3;
    return title.includes(q) ? 4 : -1;
  };
  const number = (c: KanbanCard) => Number(c.id.slice(c.id.lastIndexOf('-') + 1));
  return cards
    .map((card) => ({ card, score: match(card) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) =>
      Number(b.card.project === project && project !== null) - Number(a.card.project === project && project !== null)
      || a.score - b.score
      || COLUMN_ORDER[a.card.column] - COLUMN_ORDER[b.card.column]
      || number(b.card) - number(a.card))
    .map((x) => x.card);
}

const kanbanSource: MentionSource = {
  id: 'kanban',
  label: 'composer.sourceKanban',
  icon: SquareKanban,
  async search(query, project) {
    const { cards } = await api<{ cards: KanbanCard[] }>('/api/kanban');
    return rankCards(cards, query, project).slice(0, MAX_ITEMS).map((c) => ({
      id: c.id,
      label: c.title,
      hint: c.project ?? undefined,
      mention: mentionFor(c.path, `${c.id}: ${c.title.replace(/\s+/g, ' ')}`),
    }));
  },
};

// Plain words, not a path: a session reads a document through its tool, the rule in its system prompt says how.
const documentSource: MentionSource = {
  id: 'documents',
  label: 'composer.sourceDocuments',
  icon: Library,
  async search(query, project) {
    const docs = await api<DocumentInfo[]>(`/api/documents?q=${encodeURIComponent(query.trim())}`);
    const own = (d: DocumentInfo) => Number(d.project === project && project !== null);
    return docs.slice().sort((a, b) => own(b) - own(a)).slice(0, MAX_ITEMS).map((d) => ({
      id: d.kind,
      label: d.title,
      hint: d.project ?? undefined,
      mention: `@document ${d.id} «${d.title.replace(/\s+/g, ' ')}»`,
    }));
  },
};

const sources: MentionSource[] = [kanbanSource, documentSource];

export function addMentionSource(source: MentionSource) {
  if (!sources.some((s) => s.id === source.id)) sources.push(source);
}

export const mentionSources = (): readonly MentionSource[] => sources;
export const mentionSource = (id: string | null) => sources.find((s) => s.id === id) ?? null;

/** Text after the @ of an opened section: spaces are part of a search there, a new line ends it. Null: the caret left it. */
export function openedQuery(value: string, caret: number, start: number): string | null {
  if (value[start] !== '@' || caret <= start) return null;
  const query = value.slice(start + 1, caret);
  return query.includes('\n') ? null : query;
}

export function mentionRows(query: string, opened: string | null, found: Record<string, MentionItem[]>, files: string[] | null, labelOf: (key: Key) => string): MentionRow[] {
  const inside = mentionSource(opened);
  if (inside) return (found[inside.id] ?? []).map((item) => ({ kind: 'item', source: inside, item }));
  const q = query.toLowerCase();
  const rows: MentionRow[] = [];
  for (const source of sources) if (!q || labelOf(source.label).toLowerCase().includes(q)) rows.push({ kind: 'section', source });
  if (q) for (const source of sources) for (const item of (found[source.id] ?? []).slice(0, PREVIEW)) rows.push({ kind: 'item', source, item });
  for (const path of (files ?? []).slice(0, MAX_FILES)) rows.push({ kind: 'file', path });
  return rows;
}
