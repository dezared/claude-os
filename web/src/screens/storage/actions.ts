import { Combine, Sparkles } from 'lucide-react';
import type { MenuItem } from '@/home/ActionMenu';
import { api } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { toastError } from '@/lib/store';
import type { MemoryNoteList, MemoryProjectStats } from '@/lib/types';

const DUPLICATES_SHOWN = 200;

/** What the panel knows about the project, as the prompt's context: in English, figures only. */
function contextOf(s: MemoryProjectStats): string {
  const types = Object.entries(s.types).map(([k, n]) => `${k || 'none'} ${n}`).join(', ');
  const tags = s.tags.map(([tag, n]) => `${tag} ${n}`).join(', ');
  const h = s.health;
  return `${s.notes} notes (${s.outside} read only outside the vault). Types: ${types}. Top tags: ${tags || 'none'}. `
    + `Format issues ${h.malformed}, broken links ${h.broken}, duplicates ${h.duplicate}, notes without links ${h.orphan}.`;
}

async function dedupe(project: string) {
  try {
    const list = await api<MemoryNoteList>(`/api/memory/list?project=${encodeURIComponent(project)}&health=duplicate&limit=${DUPLICATES_SHOWN}`);
    const lines = list.rows.map((r) => `- ${r.name}: ${r.summary ?? ''}`).join('\n');
    const more = list.total > list.rows.length ? `\n(and ${list.total - list.rows.length} more: find them with memory_search)` : '';
    runMicrotask({ id: 'memory-dedupe', vars: { project, context: lines + more }, project });
  } catch (e) {
    toastError(e);
  }
}

/** The project's notes, handed to Claude: tidy them up to the note rules, merge what duplicates. */
export function storageMenu(s: MemoryProjectStats, vaultPath: string): MenuItem[] {
  const project = s.project;
  if (project === null) return [];
  const folder = `${vaultPath}/projects/${project}`;
  return [
    { id: 'memory.reorganize', label: t('storage.reorganize'), icon: Sparkles, onSelect: () => runMicrotask({ id: 'memory-reorganize', vars: { project, folder, context: contextOf(s) }, project }) },
    {
      id: 'memory.dedupe',
      label: s.health.duplicate > 0 ? t('storage.dedupeN', { n: fmtInt(s.health.duplicate) }) : t('storage.dedupe'),
      icon: Combine,
      disabled: s.health.duplicate === 0,
      onSelect: () => void dedupe(project),
    },
  ];
}
