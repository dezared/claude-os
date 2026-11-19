// The board's tools inside the claude-os MCP server, under the names the built-in board had, so prompts keep working.
import type { PluginHost, PluginTool, PluginWho } from '../../../server/tools/pluginServerApi.ts';
import type { Kanban } from './board.ts';
import { COLUMNS, PRIORITIES, TYPES, type Actor } from './types.ts';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Runs the change; a refusal goes back to the model as text. A change refreshes the board on screen. */
function attempt(host: PluginHost, change: boolean, work: () => unknown) {
  try {
    const out = work();
    if (change) host.invalidate();
    return ok(out ?? 'done');
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** The interface's words the tools give: the columns for the move tool, the name of a default board never renamed. */
export interface Words { columns: (language: string) => string; board: (language: string, id: string) => string }

function readTools(host: PluginHost, board: Kanban, words: Words) {
  const { tool, z } = host;
  return [
    tool('list_kanban_cards', 'Cards of the kanban board: id like OS-21, title, description, project, type, priority, column, labels, estimate, assignee or agent, level, board, sessions, comments (a count) and path, the card file .md in the vault. The order of the list is the order on the board.', {
      project: z.string().nullable().optional().describe('Project key; null: only general ones; omitted: all'),
      board: z.string().optional().describe('Board id from list_kanban_boards; omitted: every board'),
    }, async ({ project, board: on }) => attempt(host, false, () => board.list({ board: on }).filter((c) => project === undefined || c.project === project)), { annotations: { readOnlyHint: true } }),
    tool('get_kanban_card', 'One card with its log, oldest first: created, moved, taken (by which agent, tab and session), edited, moves between boards and comments.', {
      id: z.string().describe('Card id, for example OS-21'),
    }, async ({ id }) => attempt(host, false, () => board.detail(id)), { annotations: { readOnlyHint: true } }),
    tool('list_kanban_boards', 'Boards of the kanban: id, name, project (a board made for one project), goal and the number of its cards. A card names its board by id; epics and tasks are the default boards.', {}, async () => attempt(host, false, () => {
      const cards = board.list();
      return board.boards().map((x) => ({ ...x, name: x.name ?? words.board(host.language(), x.id), cards: cards.filter((c) => c.board === x.id).length }));
    }), { annotations: { readOnlyHint: true } }),
  ];
}

const CARD_FIELDS = (z: PluginHost['z']) => ({
  description: z.string().optional().describe('Markdown, replaces the whole description'),
  project: z.string().nullable().optional().describe('Project key from list_projects, null: not about one project'),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  labels: z.array(z.string()).optional().describe('Replaces all labels'),
  estimate: z.number().nullable().optional().describe('Story points; null: none'),
  level: z.enum(['user', 'root']).nullable().optional().describe('Only for cards of the Claude OS project: user for config/, root for the core (server, web, shared, e2e); null: no level'),
  board: z.string().nullable().optional().describe('Board id from list_kanban_boards; null: the default board of its type (epics for an epic, else tasks); omitted: unchanged'),
});

function cardTools(host: PluginHost, board: Kanban, actor: Actor, words: Words) {
  const { tool, z } = host;
  const done = (work: () => unknown) => attempt(host, true, work);
  return [
    tool('add_kanban_card', 'Add a card to the kanban. A card is a .md file in the vault, the description in Markdown. Without a board an epic goes onto the epics board, anything else onto tasks. The answer holds its id.', {
      title: z.string().min(1), ...CARD_FIELDS(z),
      column: z.enum(COLUMNS).optional().describe('Defaults to backlog'),
      agent: z.string().optional().describe('Who took the task right away'),
    }, async (input) => done(() => board.add(input, actor))),
    tool('move_kanban_card', `Move a card: to a column and, if needed, before another card of that column. Columns as the user sees them: ${words.columns(host.language())}. In backlog and todo the agent mark is cleared.`, {
      id: z.string().describe('Card id, for example OS-21'),
      column: z.enum(COLUMNS),
      before: z.string().nullable().optional().describe('Id of the card to stand before; omitted: the end of the column'),
      agent: z.string().nullable().optional().describe('Who is working on the task; null clears the mark; omitted: unchanged'),
      board: CARD_FIELDS(z).board,
    }, async ({ id, ...place }) => done(() => board.move(id, place, actor))),
    tool('take_kanban_card', 'Take a task: the agent name appears on the card, and a card in backlog or todo moves to doing. Call it when you start working on a card.', {
      id: z.string().describe('Card id, for example OS-21'),
      agent: z.string().optional().describe('Agent name. Omitted: the name of this tab'),
    }, async ({ id, agent }) => done(() => board.take(id, agent ?? actor.by, actor))),
    tool('update_kanban_card', 'Change the fields of a card. Give only what you change. A card moved to another project gets that project\'s id; the old id keeps finding it. Answer: the whole card.', {
      id: z.string().describe('Card id, for example OS-21'),
      title: z.string().min(1).optional(), ...CARD_FIELDS(z),
    }, async ({ id, ...input }) => done(() => board.update(id, input, actor))),
    tool('add_kanban_comment', 'Add a comment to a card: what was done, found or decided, in Markdown. It shows in the card\'s log with this tab\'s name and session.', {
      id: z.string().describe('Card id, for example OS-21'),
      text: z.string().min(1),
    }, async ({ id, text }) => done(() => board.comment(id, text, actor))),
  ];
}

function boardTools(host: PluginHost, board: Kanban) {
  const { tool, z } = host;
  const done = (work: () => unknown) => attempt(host, true, work);
  const fields = { project: z.string().nullable().optional().describe('Project key: a board made for one project, its new cards get that project; null: none'), goal: z.string().nullable().optional() };
  return [
    tool('add_kanban_board', 'Add a board to the kanban, for example one for a project, a release or a kind of work. Answer: the board with its id. Put cards on it with update_kanban_card.', { name: z.string().min(1), ...fields }, async (input) => done(() => board.addBoard(input))),
    tool('update_kanban_board', 'Rename a board, or change its project or goal. Give only what you change.', { id: z.string(), name: z.string().min(1).optional(), ...fields }, async ({ id, ...input }) => done(() => board.updateBoard(id, input))),
  ];
}

/** Every session kind has every tool; a work tab asks before adding a card or changing the boards. Only the user removes a board. */
export function kanbanTools(host: PluginHost, board: Kanban, who: PluginWho, words: Words): PluginTool[] {
  const actor: Actor = { by: who.agent ?? 'Claude', tab: who.tab };
  return [...readTools(host, board, words), ...cardTools(host, board, actor, words), ...boardTools(host, board)];
}

const READS = ['list_kanban_cards', 'list_kanban_boards', 'get_kanban_card'];
const CARD_EDITS = ['move_kanban_card', 'take_kanban_card', 'update_kanban_card', 'add_kanban_comment'];

// A work tab reads the board, marks what it took, edits and comments on a card: adding a card or a board asks, the board is the user's.
// The root tab and a service task add cards and boards too.
export const ALLOWED = {
  work: [...READS, ...CARD_EDITS],
  root: [...READS, 'add_kanban_card', ...CARD_EDITS, 'add_kanban_board', 'update_kanban_board'],
  serviceTask: [...READS, 'add_kanban_card', ...CARD_EDITS, 'add_kanban_board', 'update_kanban_board'],
};
