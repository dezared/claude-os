import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { formatHits } from '../memory/search.ts';

// `project`: the tab's own; its notes are searched by default and rank first in a search of all.
// Loaded with the session, not deferred behind tool search: every session searches memory, and a deferred tool
// cost each one a ToolSearch round trip before its first search.
export const memorySearchTool = (ctx: Ctx, project: string | null) => tool('memory_search', 'Search all memory notes (MEMORY.md lists only some) by English keywords. Returns snippets only; Read the path for the whole note.', {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional().describe('Defaults to 5'),
  project: z.string().optional().describe('Project key; "*": all projects. Defaults to the project of this tab'),
}, async ({ query, limit = 5, project: only }) => {
  const hits = await ctx.memory.find(query, { limit, project: only === '*' ? null : only ?? project, boost: project });
  return { content: [{ type: 'text' as const, text: formatHits(hits) }] };
}, { annotations: { readOnlyHint: true }, alwaysLoad: true });
