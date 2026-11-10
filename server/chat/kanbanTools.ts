// The kanban board's MCP tools. A work tab gets the reads and the edits of one card; the root tab and the service task get all.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KANBAN_COLUMNS } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { kanbanFor } from '../tools/kanban.ts';
import { fail, ok } from './dispatchTools.ts';
import { kanbanColumnLabels } from './profile.ts';

const KANBAN_COLUMN = z.enum(KANBAN_COLUMNS);

// Who takes a card when it does not name itself: the tab's own name.
export interface BoardAgent { name?: string; tab?: string; }

const KANBAN_SPRINT = z.string().nullable().optional().describe('Sprint id from list_kanban_sprints; null: no sprint; omitted: unchanged');

export const listKanbanTool = (ctx: Ctx) => tool('list_kanban_cards', 'Cards of the kanban board: id like OS-21, title, description, project, priority, column, level, sprint, agent, sessions and path, the card file .md in the vault. The order of the list is the order on the board.', {
  project: z.string().nullable().optional().describe('Project key; null: only general ones; omitted: all'),
}, async ({ project }) => {
  try {
    return ok(kanbanFor(ctx).list().filter((c) => project === undefined || c.project === project));
  } catch (err) {
    return fail((err as Error).message);
  }
}, { annotations: { readOnlyHint: true } });

export const moveKanbanTool = (ctx: Ctx) => tool('move_kanban_card', `Move a card: to a column and, if needed, before another card of that column. Columns as the user sees them: ${kanbanColumnLabels(ctx.settings?.profile()?.language ?? 'en')}. In backlog and todo the agent mark is cleared.`, {
  id: z.string().describe('Card id, for example OS-21'),
  column: KANBAN_COLUMN,
  before: z.string().nullable().optional().describe('Id of the card to stand before; omitted: the end of the column'),
  agent: z.string().nullable().optional().describe('Who is working on the task; null clears the mark; omitted: unchanged'),
  sprint: KANBAN_SPRINT,
}, async ({ id, column, before, agent, sprint }) => {
  try {
    const card = kanbanFor(ctx).move(id, column, before, agent, undefined, sprint);
    ctx.audit('kanban.move', card.id, column);
    ctx.invalidate('kanban');
    return ok(card);
  } catch (err) {
    return fail((err as Error).message);
  }
});

export const takeKanbanTool = (ctx: Ctx, who: BoardAgent = {}) => tool('take_kanban_card', 'Take a task: the agent name appears on the card, and a card in backlog or todo moves to doing. Call it when you start working on a card.', {
  id: z.string().describe('Card id, for example OS-21'),
  agent: z.string().optional().describe('Agent name. Omitted: the name of this tab'),
}, async ({ id, agent }) => {
  try {
    const card = kanbanFor(ctx).take(id, agent ?? who.name ?? 'Claude', who.tab);
    ctx.audit('kanban.take', card.id, card.agent);
    ctx.invalidate('kanban');
    return ok(card);
  } catch (err) {
    return fail((err as Error).message);
  }
});

export const updateKanbanTool = (ctx: Ctx) => tool('update_kanban_card', 'Change the fields of a card. Give only what you change. A card moved to another project gets that project\'s id; the old id keeps finding it. Answer: the whole card.', {
  id: z.string().describe('Card id, for example OS-21'),
  title: z.string().min(1).optional(),
  description: z.string().optional().describe('Markdown, replaces the whole description'),
  project: z.string().nullable().optional().describe('Project key from list_projects, null: not about one project'),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  level: z.enum(['user', 'root']).nullable().optional().describe('Only for cards of the Claude OS project; null: no level'),
  sprint: KANBAN_SPRINT,
}, async ({ id, ...input }) => {
  try {
    const card = kanbanFor(ctx).update(id, input);
    ctx.audit('kanban.update', card.id, Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k).join(', '));
    ctx.invalidate('kanban');
    return ok(card);
  } catch (err) {
    return fail((err as Error).message);
  }
});

export const listSprintsTool = (ctx: Ctx) => tool('list_kanban_sprints', 'Sprints of the kanban board: id and name. A card names its sprint by id; a card with no sprint or an unknown one is in no sprint.', {}, async () => {
  try {
    return ok(kanbanFor(ctx).sprints());
  } catch (err) {
    return fail((err as Error).message);
  }
}, { annotations: { readOnlyHint: true } });

const sprintTools = (ctx: Ctx) => [
  listSprintsTool(ctx),

  tool('add_kanban_sprint', 'Add a sprint to the kanban board. Answer: the sprint with its id.', { name: z.string().min(1) }, async ({ name }) => {
    try {
      const sprint = kanbanFor(ctx).addSprint(name);
      ctx.audit('kanban.sprint.add', sprint.id, sprint.name);
      ctx.invalidate('kanban');
      return ok(sprint);
    } catch (err) {
      return fail((err as Error).message);
    }
  }),

  tool('update_kanban_sprint', 'Rename a sprint.', { id: z.string(), name: z.string().min(1) }, async ({ id, name }) => {
    try {
      const sprint = kanbanFor(ctx).updateSprint(id, name);
      ctx.audit('kanban.sprint.update', sprint.id, sprint.name);
      ctx.invalidate('kanban');
      return ok(sprint);
    } catch (err) {
      return fail((err as Error).message);
    }
  }),

  tool('remove_kanban_sprint', 'Remove a sprint. Its cards stay in their columns with no sprint.', { id: z.string() }, async ({ id }) => {
    try {
      kanbanFor(ctx).removeSprint(id);
      ctx.audit('kanban.sprint.delete', id);
      ctx.invalidate('kanban');
      return ok('removed');
    } catch (err) {
      return fail((err as Error).message);
    }
  }),
];

export const kanbanTools = (ctx: Ctx, who?: BoardAgent) => [
  listKanbanTool(ctx),

  tool('add_kanban_card', 'Add a card to the kanban board. A card is a .md file in the vault, the description in Markdown. The answer holds its id.', {
    title: z.string().min(1),
    description: z.string().optional().describe('Markdown'),
    project: z.string().nullable().optional().describe('Project key from list_projects, null: not about one project'),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    column: KANBAN_COLUMN.optional().describe('Defaults to backlog'),
    level: z.enum(['user', 'root']).optional().describe('Only for cards of the Claude OS project: what the task changes. user: config/, root: the core (server, web, shared, e2e)'),
    agent: z.string().optional().describe('Who took the task right away'),
    sprint: z.string().optional().describe('Sprint id from list_kanban_sprints'),
  }, async (input) => {
    try {
      const card = kanbanFor(ctx).add(input);
      ctx.audit('kanban.add', card.id, card.title);
      ctx.invalidate('kanban');
      return ok(card);
    } catch (err) {
      return fail((err as Error).message);
    }
  }),

  moveKanbanTool(ctx),

  takeKanbanTool(ctx, who),

  updateKanbanTool(ctx),

  ...sprintTools(ctx),
];
