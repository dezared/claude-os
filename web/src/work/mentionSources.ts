// What the @ menu offers besides the project's files. A source is a section at the top of the menu: arrows and Space open
// it, then typing searches inside it. A plugin adds one as `mentions` of its interface; Composer needs no change.
import { Library, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { DocumentInfo } from '@/lib/types';
import { pluginMentions } from '@/lib/uiPlugins';

export interface MentionItem {
  id: string; // short and searchable, shown in mono: OS-21
  label: string;
  hint?: string;
  mention: string; // what goes into the text, with its @
}

export interface MentionSource {
  id: string;
  label: () => string;
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

// Plain words, not a path: a session reads a document through its tool, the rule in its system prompt says how.
const documentSource: MentionSource = {
  id: 'documents',
  label: () => t('composer.sourceDocuments'),
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

// Enabled plugins add theirs, such as a board's cards, ahead of the documents.
export const mentionSources = (): readonly MentionSource[] => [...pluginMentions(), documentSource];
export const mentionSource = (id: string | null) => mentionSources().find((s) => s.id === id) ?? null;

/** Text after the @ of an opened section: spaces are part of a search there, a new line ends it. Null: the caret left it. */
export function openedQuery(value: string, caret: number, start: number): string | null {
  if (value[start] !== '@' || caret <= start) return null;
  const query = value.slice(start + 1, caret);
  return query.includes('\n') ? null : query;
}

export function mentionRows(query: string, opened: string | null, found: Record<string, MentionItem[]>, files: string[] | null): MentionRow[] {
  const inside = mentionSource(opened);
  if (inside) return (found[inside.id] ?? []).map((item) => ({ kind: 'item', source: inside, item }));
  const q = query.toLowerCase();
  const rows: MentionRow[] = [];
  const sources = mentionSources();
  for (const source of sources) if (!q || source.label().toLowerCase().includes(q)) rows.push({ kind: 'section', source });
  if (q) for (const source of sources) for (const item of (found[source.id] ?? []).slice(0, PREVIEW)) rows.push({ kind: 'item', source, item });
  for (const path of (files ?? []).slice(0, MAX_FILES)) rows.push({ kind: 'file', path });
  return rows;
}
