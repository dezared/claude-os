import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { formatHits } from '../memory/search.ts';

// `project`: the tab's own; its notes are searched by default and rank first in a search of all.
export const memorySearchTool = (ctx: Ctx, project: string | null) => tool('memory_search', 'Search memory notes by English keywords. Returns snippets only; Read the path for the whole note.', {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional().describe('Defaults to 5'),
  project: z.string().optional().describe('Project key; "*": all projects. Defaults to the project of this tab'),
}, async ({ query, limit = 5, project: only }) => {
  const hits = ctx.memory.search(query, { limit, project: only === '*' ? null : only ?? project, boost: project });
  return { content: [{ type: 'text' as const, text: formatHits(hits) }] };
}, { annotations: { readOnlyHint: true } });
