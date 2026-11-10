import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { UiCommand, UiView } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { DOCUMENT_KINDS, UI_ACTION_SET, UI_VIEW_SET } from '../../shared/contract.ts';
import { documentLink } from '../../shared/documents.ts';
import { documentsFor } from '../tools/documents.ts';
import { fileNote, itemsOf, plannerDir, removeItem, saveText, setItem } from '../tools/planner.ts';
import { createProjectTool, fail, ok, resumeSessionTool } from './dispatchTools.ts';
import { kanbanTools, listKanbanTool, listSprintsTool, moveKanbanTool, takeKanbanTool, updateKanbanTool } from './kanbanTools.ts';
import { kitTools } from './kitTools.ts';
import type { Chat } from './manager.ts';
import { memorySearchTool } from './memoryTool.ts';
import { progressStatusLabels } from './profile.ts';

export { projectDirFor } from './dispatchTools.ts';

export const ROOT_MCP_NAME = 'claude-os';
export const ROOT_READ_TOOLS = ['list_projects', 'list_sessions', 'session_status', 'memory_search', 'list_kanban_cards', 'list_kanban_sprints'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);
// Writes, but only moves one note or changes one of its items, inside the planner folder: no prompt for every note.
export const ROOT_PLANNER_TOOLS = ['file_planner_note', 'check_planner_item', 'remove_planner_item'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);
// In a work tab only marking goes without a prompt: it can be undone, a removed item cannot.
export const WORK_PLANNER_TOOL = `mcp__${ROOT_MCP_NAME}__check_planner_item`;
// Reads snippets of memory notes: every tab, no prompt.
export const MEMORY_SEARCH_TOOL = `mcp__${ROOT_MCP_NAME}__memory_search`;
// A work tab reads the board, marks what it took and edits a card: nothing leaves a card's file.
export const WORK_KANBAN_TOOLS = ['list_kanban_cards', 'list_kanban_sprints', 'move_kanban_card', 'take_kanban_card', 'update_kanban_card'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);
// The same for the board: a card is added, moved or edited, a sprint added or renamed. Removing a sprint asks.
export const ROOT_KANBAN_TOOLS = ['add_kanban_card', 'move_kanban_card', 'take_kanban_card', 'update_kanban_card', 'add_kanban_sprint', 'update_kanban_sprint'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// Everything the service session has, all without a prompt: nobody is there to answer one.
export const SERVICE_TOOLS = ['file_planner_note', 'set_planner_note_text'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// The root session hands work out and restarts the server without a prompt: that is its job, and the user asked for it.
export const ROOT_DISPATCH_TOOLS = ['open_session', 'open_sessions', 'resume_session', 'create_project', 'service_task', 'restart_claude_os'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// A task from the user: reading, the board, notes, and a tab when the job is too big. Files go through canUseTool.
export const SERVICE_TASK_TOOLS = ['list_projects', 'list_sessions', 'memory_search', 'list_kanban_cards', 'list_kanban_sprints', 'add_kanban_card', 'move_kanban_card', 'take_kanban_card', 'update_kanban_card', 'add_kanban_sprint', 'update_kanban_sprint', 'file_planner_note', 'check_planner_item', 'remove_planner_item', 'set_project_map', 'update_project', 'open_session', 'ask_owner', 'list_documents', 'read_document', 'save_document', 'patch_document', 'set_document_share', 'list_document_knowledge', 'read_document_knowledge', 'create_document_knowledge'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// The library of documents, in every session and without a prompt: nothing here reaches outside data/documents and config/document-knowledge.
export const DOCUMENT_TOOLS = ['list_documents', 'read_document', 'save_document', 'patch_document', 'set_document_share', 'list_document_knowledge', 'read_document_knowledge', 'create_document_knowledge'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// Changes only how something looks or is described, and can be set back: no prompt, and the root session may do it too.
export const ROOT_PROJECT_TOOLS = ['update_project', 'set_project_map'].map((t) => `mcp__${ROOT_MCP_NAME}__${t}`);

// The one way from a session to the interface. Harmless by design: it shows something or moves the view, so no prompt.
export const UI_TOOL = `mcp__${ROOT_MCP_NAME}__ui_action`;

// In the system prompt: when to speak up belongs to the instructions, a tool's description alone is easy to pass by.
export const UI_TOOL_RULE = `Reach the user outside the chat only through ${UI_TOOL}: one notify at the very end of the turn, when the whole request is done or you cannot go on without the user's answer.`;

// The chat makes a path a link to the file; a shortened one names no file.
export const PATH_RULE = 'Write file paths in full (absolute), never shortened; the UI shortens them for display.';

// The bar of this tab on the home screen. Loaded with the prompt, not deferred: a ToolSearch before the first report would cost more than all of them.
export const PROGRESS_TOOL = `mcp__${ROOT_MCP_NAME}__report_progress`;
export const PROGRESS_RULE = `Call ${PROGRESS_TOOL} only for a task of more than about 5-10 minutes, with subagents or long steps, silently at step boundaries, and at the end with percent 100 and status "done".`;

const SESSION_LIST_LIMIT = 50;
// Labels in the descriptions follow the user's language as it is when the server is built.
const language = (ctx: Ctx) => ctx.settings?.profile()?.language ?? 'en';
const PLANNER_ITEM = z.union([z.number().int().positive(), z.string().min(1)]).describe('Number of the item, from 1 in the order of the note, or its exact text');

// Every tab gets these two: a session that finished a task from a note marks it where it works.
const plannerItemTools = (ctx: Ctx) => [
  tool('check_planner_item', 'Mark an item of a planner note (a `- [ ] text` line) done or clear the mark. Answer: all items of the note with their numbers.', {
    id: z.string().describe('Note id: its file name without .md'),
    item: PLANNER_ITEM,
    done: z.boolean(),
  }, async ({ id, item, done }) => {
    try {
      const note = setItem(plannerDir(ctx), id, item, done);
      ctx.invalidate('planner');
      return ok({ path: note.path, items: itemsOf(note.text) });
    } catch (err) {
      return fail((err as Error).message);
    }
  }),

  tool('remove_planner_item', 'Remove an item from a planner note. The numbers of the items after it shift. Answer: the remaining items with their numbers.', {
    id: z.string().describe('Note id: its file name without .md'),
    item: PLANNER_ITEM,
  }, async ({ id, item }) => {
    try {
      const note = removeItem(plannerDir(ctx), id, item);
      ctx.audit('planner.item.delete', note.path, String(item));
      ctx.invalidate('planner');
      return ok({ path: note.path, items: itemsOf(note.text) });
    } catch (err) {
      return fail((err as Error).message);
    }
  }),
];

const UI_VIEWS = Object.keys(UI_VIEW_SET) as [UiView, ...UiView[]];
const UI_ACTIONS = Object.keys(UI_ACTION_SET) as [UiCommand['action'], ...UiCommand['action'][]];

/** Input of the tool -> what the browser runs. A string is what to tell Claude was wrong. */
export function uiCommand(input: { action: UiCommand['action']; kind?: 'done' | 'question'; text?: string; view?: UiView; project?: string }, projects: { key: string }[]): UiCommand | string {
  const text = input.text?.trim() ?? '';
  if (input.action === 'notify') return input.kind ? { action: 'notify', kind: input.kind, text: text || null } : 'notify: kind is required: done or question';
  if (input.action === 'toast') return text ? { action: 'toast', text } : 'toast: text is required';
  if (!input.view) return `open: view is required: ${UI_VIEWS.join(', ')}`;
  if (input.project && !projects.some((p) => p.key === input.project)) return `Project "${input.project}" not found. list_projects gives the keys.`;
  return { action: 'open', view: input.view, project: input.project ?? null };
}

// `project`: where a new document goes when the session names none, its own project in a tab. A new set per query, so what it has read is this conversation's.
const documentTools = (ctx: Ctx, project: string | null) => {
  const docs = documentsFor(ctx);
  const read = new Set<string>();
  const attempt = (work: () => unknown) => {
    try {
      return ok(work() as object);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
  const saved = ({ doc, warnings }: ReturnType<typeof docs.save>) => {
    ctx.chat?.renameDocument(doc.id, doc.title);
    ctx.audit('documents.save', doc.id, doc.title);
    ctx.invalidate('documents');
    return { id: doc.id, title: doc.title, version: doc.version, link: documentLink(doc.id), warnings, answer: `In your answer give the link to the document: [${doc.title}](${documentLink(doc.id)}). A click on it opens the document in a tab.` };
  };
  return [
    tool('list_documents', 'Claude OS documents: reports, documentation, plans, dashboards. Without query all of them, newest first.', {
      query: z.string().optional().describe('Words to search for in the title and the text'),
      project: z.string().nullable().optional().describe('Project key; null: only general ones; omitted: all'),
    }, async ({ query, project: only }) => attempt(() => docs.search(query ?? '').filter((d) => only === undefined || d.project === only).map((d) => ({ ...d, link: documentLink(d.id) }))),
    { annotations: { readOnlyHint: true } }),

    tool('read_document', 'The HTML of a document and its details: needed before a change.', { id: z.string() }, async ({ id }) => attempt(() => ({ ...docs.get(id), html: docs.html(id) })),
    { annotations: { readOnlyHint: true } }),

    tool('list_document_knowledge', 'Knowledge files: the basis of every document, one per kind of document. Every request to make a document starts with them, then read_document_knowledge of a fitting one; none fits: create_document_knowledge.', {}, async () => attempt(() => docs.knowledgeList()),
    { annotations: { readOnlyHint: true } }),

    tool('read_document_knowledge', 'Read a knowledge file: how to build such a document. Required before save_document.', { id: z.string() }, async ({ id }) => attempt(() => {
      const found = docs.knowledge(id);
      read.add(id);
      return found;
    }), { annotations: { readOnlyHint: true } }),

    tool('create_document_knowledge', 'Create a knowledge file when no fitting basis exists, or replace your own. Describe what goes into such a document, the order of sections, the styling with ready CSS and the rules of the text: the next document is built from it alone. No JS and no external files.', {
      id: z.string().optional().describe('Latin or Cyrillic letters, words joined by hyphens. Defaults to one made from name'),
      name: z.string().min(1).describe('What the template is called in the list'),
      kind: z.enum(DOCUMENT_KINDS),
      description: z.string().min(1).describe('When to take this template, in one line'),
      text: z.string().min(1).describe('The text of the file in Markdown'),
      replace: z.boolean().optional().describe('Replace an existing one: only when the user asks to change the template'),
      name_ru: z.string().optional().describe('The name in Russian, shown when the interface is in Russian. A replacement keeps the old one when this is omitted'),
      description_ru: z.string().optional().describe('The description in Russian, the same way'),
    }, async (input) => attempt(() => {
      const made = docs.createKnowledge(input);
      read.add(made.id);
      ctx.audit('documents.knowledge', made.id, made.name);
      ctx.invalidate('documents');
      return { id: made.id, path: made.path };
    })),

    tool('save_document', 'Save a document: without id a new one, with id a new version of that document. Read its knowledge file first. The HTML is shown in a sandbox without JS and network: styles in <style>, charts in SVG, images in data: URLs. Without a basis it is not saved. The answer holds a link: give it in your reply.', {
      id: z.string().optional().describe('Id of an existing document, when this is a change'),
      project: z.string().nullable().optional().describe('Project key from list_projects, null: not about one project. Defaults to the project of this tab'),
      knowledge: z.string().optional().describe('Id of the knowledge file the document is built from. Required for new ones'),
      title: z.string().optional().describe('Title. Required for new ones'),
      kind: z.enum(['report', 'documentation', 'plan', 'dashboard', 'other']).optional().describe('Kind of document. Defaults to the kind of the knowledge file'),
      summary: z.string().optional().describe('What the document is about, in one line: shown in the list'),
      html: z.string().describe('A full HTML document'),
    }, async (input) => attempt(() => {
      const basis = input.knowledge ?? (input.id ? docs.get(input.id).knowledge : undefined);
      if (!basis) throw new Error('knowledge: a document is built from a knowledge file. list_document_knowledge gives the list; none fits: make one with create_document_knowledge.');
      docs.knowledge(basis); // no such file says so first: reading it would not help
      if (!read.has(basis)) throw new Error(`Read the basis first: read_document_knowledge("${basis}").`);
      return saved(docs.save({ ...input, project: input.project === undefined && !input.id ? project : input.project }));
    })),

    tool('patch_document', 'A pinpoint change to a document: replace one fragment of HTML. Cheaper than sending it all again.', {
      id: z.string(),
      find: z.string().min(1).describe('The exact fragment, occurring exactly once'),
      replace: z.string(),
    }, async ({ id, find, replace }) => attempt(() => saved(docs.patch(id, find, replace)))),

    tool('set_document_share', 'Record the link to the copy of the document in claude.ai once the upload is done: it shows in the interface.', {
      id: z.string(),
      url: z.string().describe('https://claude.ai/...'),
    }, async ({ id, url }) => attempt(() => {
      const doc = docs.share(id, url);
      ctx.audit('documents.share', doc.id, url);
      ctx.invalidate('documents');
      return { id: doc.id, shared: doc.shared };
    })),
  ];
};

// A session speaks for itself: the tab is known when the server is made, the model never names it.
export const uiTool = (ctx: Ctx, tabId: string) => tool('ui_action', 'Do something in the Claude OS interface. notify: a notification to the user, once at the end of the turn, when everything is done (kind done) or their answer is needed (kind question); never between steps or after intermediate results, every notification distracts. A permission request and AskUserQuestion notify by themselves. toast: a short line over the screen. open: open a screen (view); for projects a project can be given.', {
  action: z.enum(UI_ACTIONS),
  kind: z.enum(['done', 'question']).optional().describe('For notify'),
  text: z.string().max(300).optional().describe('For notify and toast: a short phrase'),
  view: z.enum(UI_VIEWS).optional().describe('For open'),
  project: z.string().optional().describe('For open: project key'),
}, async (input) => {
  const command = uiCommand(input, ctx.journal.listProjects(true));
  if (typeof command === 'string') return fail(command);
  ctx.broadcast({ t: 'ui', tabId, command });
  return ok('Done');
}, { alwaysLoad: true });

export const progressTool = (ctx: Ctx, tabId: string) => tool('report_progress', `The progress bar of this tab on the home screen. Only for a task longer than about 5-10 minutes, one that starts subagents, or one with long steps (tests, builds, installs); never for short answers or small edits. Subagents never call it: the main agent reports. Statuses as the user sees them: ${progressStatusLabels(language(ctx))}.`, {
  percent: z.number().describe('0-100'),
  step: z.string().optional().describe('The current step, a couple of words'),
  status: z.enum(['working', 'waiting', 'done', 'failed']).optional(),
  restart: z.boolean().optional().describe('New work: the percent may go down'),
}, async (input) => {
  ctx.chat?.reportProgress(tabId, input);
  return ok('ok');
}, { alwaysLoad: true });

export const createPlannerMcp = (ctx: Ctx, tabId: string, agent?: string, project: string | null = null) => createSdkMcpServer({ name: ROOT_MCP_NAME, tools: [...plannerItemTools(ctx), uiTool(ctx, tabId), progressTool(ctx, tabId), memorySearchTool(ctx, project), listKanbanTool(ctx), listSprintsTool(ctx), moveKanbanTool(ctx), takeKanbanTool(ctx, { name: agent, tab: tabId }), updateKanbanTool(ctx), ...documentTools(ctx, project), ...kitTools(ctx, tabId)] });

const PERMISSION_MODE = z.enum(['default', 'acceptEdits', 'auto', 'plan']).optional().describe('Permission mode of the tab. Defaults to the one in settings');

const openSessionTool = (ctx: Ctx, chat: Chat) => tool('open_session', 'Open a tab of an existing project and start a session in it with the given request. The user sees the tab.', {
  project: z.string().describe('Project key from list_projects'),
  prompt: z.string().min(1),
  title: z.string().optional().describe('Short tab name'),
  permission_mode: PERMISSION_MODE,
}, async ({ project, prompt, title, permission_mode }) => {
  const found = ctx.journal.listProjects(true).find((p) => p.key === project);
  if (!found) return fail(`Project "${project}" not found. list_projects gives the keys.`);
  return ok(chat.openWithPrompt({ project: found.key, cwd: found.root, title }, prompt, { permissionMode: permission_mode }));
});

const listProjectsTool = (ctx: Ctx) => tool('list_projects', 'Projects known to Claude OS: key, folder, number of sessions, last activity, manual choice for the map.', {}, async () =>
  ok(ctx.journal.listProjects().map(({ key, name, root, sessionCount, liveCount, lastActivity, mapPin, description, color, parent, folder }) => ({ key, name, root, sessionCount, liveCount, lastActivity, mapPin, description, color, parent, folder }))),
{ annotations: { readOnlyHint: true } });

const listSessionsTool = (ctx: Ctx) => tool('list_sessions', `Claude sessions on this machine, newest first, up to ${SESSION_LIST_LIMIT}.`, {
        project: z.string().optional().describe('Project key'),
        live: z.boolean().optional().describe('Only unfinished ones'),
      }, async ({ project, live }) => {
        const sessions = ctx.journal.listSessions()
          .filter((s) => (!project || s.project === project) && (!live || s.status !== 'ended'))
          .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
          .slice(0, SESSION_LIST_LIMIT);
        return ok(sessions.map(({ id, project: key, cwd, status, title, lastPrompt, lastActivity, origin }) => ({ id, project: key, cwd, status, title, lastPrompt, lastActivity, origin })));
      }, { annotations: { readOnlyHint: true } });

const setProjectMapTool = (ctx: Ctx) => tool('set_project_map', 'The project map: true keeps a project on the map, false removes it from the map, null returns the automatic choice by latest activity.', {
  project: z.string().describe('Project key'),
  on: z.boolean().nullable(),
}, async ({ project, on }) => {
  const p = ctx.journal.setMapPin(project, on);
  return p ? ok({ key: p.key, mapPin: p.mapPin }) : fail(`No project ${project}`);
});

const updateProjectTool = (ctx: Ctx) => tool('update_project', 'Change the data of a project. Give only what you change. Answer: the whole project.', {
  project: z.string().describe('Project key'),
  name: z.string().optional().describe('Name in the interface; the folder and the key do not change'),
  description: z.string().nullable().optional().describe('What the project is, Markdown. null: remove'),
  color: z.string().nullable().optional().describe('#rrggbb. null: a color from the map palette'),
  parent: z.string().nullable().optional().describe('Parent key. "": a top-level project. null: the folders on disk decide'),
  folder: z.boolean().optional().describe('true: this is just a folder with projects, it is not on the map'),
}, async ({ project, ...patch }) => {
  try {
    const p = ctx.journal.updateProject(project, patch);
    if (!p) return fail(`No project ${project}`);
    ctx.audit('project.update', project, JSON.stringify(patch));
    return ok(p);
  } catch (err) {
    return fail((err as Error).message);
  }
});

const fileNoteTool = (ctx: Ctx) => tool('file_planner_note', 'File a planner note: folder, topic, date, title.', {
  id: z.string(),
  folder: z.string().nullable().optional().describe('Exact name of an existing planner folder. null: the note stays in the folder it is in. Only the user creates new folders'),
  topic: z.string().min(1).describe('A short topic'),
  date: z.string().optional().describe('YYYY-MM-DD, only if the note names a day'),
  title: z.string().optional().describe('A short title: what the note is about'),
}, async ({ id, folder, topic, date, title }) => {
  try {
    const note = fileNote(plannerDir(ctx), id, { folder, topic, date, title });
    ctx.audit('planner.file', note.path);
    ctx.invalidate('planner');
    return ok({ path: note.path });
  } catch (err) {
    return fail((err as Error).message);
  }
});

export const createServiceMcp = (ctx: Ctx) => createSdkMcpServer({
  name: ROOT_MCP_NAME,
  tools: [
    fileNoteTool(ctx),
    tool('set_planner_note_text', 'Replace the text of a planner note. Refuses if the note changed since the given version.', {
      id: z.string(),
      version: z.string().describe('Version of the note from the task'),
      text: z.string().min(1),
    }, async ({ id, version, text }) => {
      try {
        const note = saveText(plannerDir(ctx), id, text, version);
        ctx.audit('planner.edit', note.path);
        ctx.invalidate('planner');
        return ok({ path: note.path, items: itemsOf(note.text) });
      } catch (err) {
        return fail((err as Error).message);
      }
    }),
  ],
});

// The user's task in the service session: what it may do by itself, the one question, and the way out to a tab.
export const createServiceTaskMcp = (ctx: Ctx, chat: Chat, extra: readonly string[] = []) => createSdkMcpServer({
  name: ROOT_MCP_NAME,
  tools: [
    listProjectsTool(ctx),
    listSessionsTool(ctx),
    memorySearchTool(ctx, null),
    setProjectMapTool(ctx),
    updateProjectTool(ctx),
    fileNoteTool(ctx),
    ...plannerItemTools(ctx),
    ...kanbanTools(ctx).filter((t) => t.name !== 'remove_kanban_sprint'), // it asks, and nobody answers a prompt here
    ...documentTools(ctx, null),
    openSessionTool(ctx, chat),
    ...[resumeSessionTool(chat), createProjectTool(ctx, chat)].filter((t) => extra.includes(t.name)), // only for a template that asks (MICROTASK_TOOLS)
    tool('ask_owner', 'Ask the user questions in one list, once per task unless the task says otherwise. End the turn right after the call: the answer comes as the next message.', {
      questions: z.array(z.string().min(1)).min(1).max(5),
    }, async ({ questions }) => {
      const asked = chat.tasks.ask(questions);
      return asked ? ok('The questions are shown to the user. End the turn with one line.') : fail('This task has already had its question. Decide yourself or open a tab with open_session.');
    }),
  ],
});

// A new instance per query: an MCP server object connects to a single transport.
export function createRootMcp(ctx: Ctx, chat: Chat, tabId: string, agent?: string) {
  return createSdkMcpServer({
    name: ROOT_MCP_NAME,
    tools: [
      listProjectsTool(ctx),

      setProjectMapTool(ctx),

      updateProjectTool(ctx),

      uiTool(ctx, tabId),

      progressTool(ctx, tabId),

      listSessionsTool(ctx),

      tool('session_status', 'State of one session by its id.', { session_id: z.string() }, async ({ session_id }) => {
        const tab = chat.list().find((t) => t.sessionId === session_id);
        const session = ctx.journal.listSessions().find((s) => s.id === session_id);
        if (!tab && !session) return fail(`Session ${session_id} not found`);
        return ok({
          id: session_id,
          status: tab?.status ?? session?.status,
          attention: tab?.attention ?? false,
          tabId: tab?.id ?? null,
          cwd: tab?.cwd ?? session?.cwd,
          title: session?.title ?? tab?.title ?? null,
          lastPrompt: session?.lastPrompt ?? null,
          lastActivity: session?.lastActivity ?? null,
        });
      }, { annotations: { readOnlyHint: true } }),

      memorySearchTool(ctx, null),

      fileNoteTool(ctx),

      ...plannerItemTools(ctx),

      ...kanbanTools(ctx, { name: agent, tab: tabId }),

      ...documentTools(ctx, null),

      openSessionTool(ctx, chat),

      resumeSessionTool(chat),

      tool('open_sessions', 'Open several tabs at once and start work in each. The user stays where they are, the tabs appear alongside.', {
        tasks: z.array(z.object({
          project: z.string().describe('Project key from list_projects'),
          prompt: z.string().min(1),
          title: z.string().optional().describe('Short tab name'),
          permission_mode: PERMISSION_MODE,
        })).min(1).max(8),
      }, async ({ tasks }) => {
        const known = ctx.journal.listProjects(true);
        const missing = tasks.find((t) => !known.some((p) => p.key === t.project));
        if (missing) return fail(`Project "${missing.project}" not found. list_projects gives the keys.`);
        return ok(tasks.map((t) => chat.openWithPrompt({ project: t.project, cwd: known.find((p) => p.key === t.project)!.root, title: t.title }, t.prompt, { focus: false, permissionMode: t.permission_mode })));
      }),

      tool('service_task', 'Hand a small Claude OS task to the hidden service session. The user sees the answer in a card; no tab opens.', {
        title: z.string().min(1).describe('A short title'),
        prompt: z.string().min(1),
        project: z.string().optional().describe('Project key, if the task is about one'),
      }, async ({ title, prompt, project }) => ok(chat.tasks.start({ title, prompt, project }))),

      tool('restart_claude_os', 'Restart the Claude OS server on the code from disk. All turns are cut; the tabs that were working, this one included, get a message and go on by themselves.', {}, async () => {
        const tabs = chat.planContinue();
        ctx.audit('app.restart', 'server', `root session, ${tabs} tabs go on`);
        ctx.restart?.();
        return ok({ restarting: true, tabsGoOn: tabs });
      }),

      createProjectTool(ctx, chat),
    ],
  });
}
