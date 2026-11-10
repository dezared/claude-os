// The profile block appended to the system prompt of every Claude OS session: who the user is, the reply
// language, how often to ask, and the UI labels that session's prompts mention, as the user's UI shows them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { KanbanColumn, Profile, QuestionLevel, TaskState } from '../../shared/contract.ts';
import type { Ctx, Paths } from '../context.ts';
import { safely } from '../memory/util.ts';
import { strings as en } from '../../web/src/lib/locales/en.ts';
import { strings as ru } from '../../web/src/lib/locales/ru.ts';

const CATALOGS: Record<string, Record<string, string>> = { en, ru };

// What the prompts call a UI element -> its catalog key. Prompts name elements this way, the block gives the label.
export const PROMPT_LABELS = {
  'root tab': 'nav.home',
  'Projects screen': 'nav.projects',
  'Tools screen': 'nav.tools',
  '"Just a folder" mark of a project': 'projectsScreen.kindFolder',
  'Widgets section of Settings': 'set.widgets',
  'Documents screen': 'documents.title',
  '"Edit with Claude" button of a document': 'documents.edit',
  '"Ask Claude" buttons': 'adm.ask',
  '"Change with Claude" menu item': 'claude.change',
  '"Create widget" menu item': 'widget.create',
  'work progress widget': 'progress.title',
  'Claude OS plugins screen': 'tools.osPlugins',
  '"Set up" button of a plugin': 'osp.setup',
  '"Update" button of a plugin': 'osp.update',
  'plugin dependency status "cannot check"': 'osp.depUnknown',
  '"Project kit…" action of a project': 'kit.menu',
} as const satisfies Record<string, keyof typeof en>;

// The one list of question levels: settings validates against its keys. Each text is how Claude behaves at that
// level; the server also caps AskUserQuestion per user message (questionCap.ts).
export const QUESTION_LEVELS: Record<QuestionLevel, string> = {
  minimal: 'Do not ask. Pick the reading the code, docs and conversation support best, state each assumption in one line in your final message, continue. Ask only when blocked: readings lead to different irreversible results, or a required input exists nowhere.',
  balanced: 'Ask only when the intent has readings that change the solution: once, before the first edit, one AskUserQuestion with every such question, 2\u20134 options each, the recommended first. Otherwise state the assumption and continue.',
  thorough: 'Before a change to more than one file or a shared concept: one AskUserQuestion round with your assumptions, scope and rejected options. Then work without questions unless something new appears.',
};

// Board columns and progress statuses go into the descriptions of move_kanban_card and report_progress instead.
const KANBAN_LABELS: Record<KanbanColumn, keyof typeof en> = { backlog: 'kanban.backlog', todo: 'kanban.todo', doing: 'kanban.doing', polish: 'kanban.polish', done: 'kanban.done' };
const PROGRESS_LABELS: Record<TaskState, keyof typeof en> = { working: 'progress.working', waiting: 'progress.waiting', done: 'progress.done', failed: 'progress.failed' };

export type PromptKind = 'root' | 'service' | 'setup' | 'work';

export function promptKindOf(paths: Pick<Paths, 'setup'>, row: { kind: string; cwd: string }): PromptKind {
  if (row.kind === 'root' || row.kind === 'service') return row.kind;
  return row.cwd === paths.setup || row.cwd.startsWith(`${paths.setup}${sep}`) ? 'setup' : 'work';
}

const read = (path: string) => safely(() => readFileSync(path, 'utf8'), '');
const references = (paths: Pick<Paths, 'root'>) => {
  const dir = join(paths.root, 'reference');
  return safely(() => readdirSync(dir), []).filter((f) => f.endsWith('.md')).sort().map((f) => read(join(dir, f)));
};

// The prompts a session of this kind loads: the labels it gets are the ones these name. A work tab gets none.
export function promptSources(paths: Pick<Paths, 'root' | 'service' | 'setup'>, kind: PromptKind): string {
  if (kind === 'root') return [read(join(paths.root, 'CLAUDE.md')), ...references(paths)].join('\n');
  if (kind === 'service') return [read(join(paths.service, 'CLAUDE.md')), ...references(paths)].join('\n');
  return kind === 'setup' ? read(join(paths.setup, 'SETUP.md')) : '';
}

const label = (language: string, key: keyof typeof en) => (CATALOGS[language] ?? en)[key] ?? en[key];

export function promptLabels(language: string, sources: string): Record<string, string> {
  return Object.fromEntries(Object.entries(PROMPT_LABELS).filter(([name]) => sources.includes(name)).map(([name, key]) => [name, label(language, key)]));
}

const labelList = (language: string, keys: Record<string, keyof typeof en>) => Object.entries(keys).map(([id, key]) => `${id} "${label(language, key)}"`).join(', ');
export const kanbanColumnLabels = (language: string) => labelList(language, KANBAN_LABELS);
export const progressStatusLabels = (language: string) => labelList(language, PROGRESS_LABELS);

// "Russian (ru)"; a code Intl does not know stays the code.
function languageName(code: string): string {
  const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
  return name && name !== code ? `${name} (${code})` : code;
}

export function profileBlock(profile: Profile | null, labels: Record<string, string>): string {
  if (!profile) return '';
  return [
    '# The user',
    `The user's name is ${profile.name}. Reply in ${languageName(profile.language)}.`,
    `Question level: ${profile.questionLevel}. ${QUESTION_LEVELS[profile.questionLevel]}`,
    ...(Object.keys(labels).length ? ['UI labels as the user sees them. Use these when you name an element:'] : []),
    ...Object.entries(labels).map(([name, text]) => `- ${name}: "${text}"`),
  ].join('\n');
}

export function sessionProfileBlock(ctx: Ctx, kind: PromptKind): string {
  const profile = ctx.settings?.profile() ?? null;
  return profile ? profileBlock(profile, promptLabels(profile.language, promptSources(ctx.paths, kind))) : '';
}
