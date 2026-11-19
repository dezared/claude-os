// Kanban+ in the Claude OS server: the board in vault/kanban, its routes, its tools in every session and the prompt rule.
import { cpSync, existsSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { PluginHost, PluginServer } from '../../../server/tools/pluginServerApi.ts';
import { createKanban } from './board.ts';
import { kanbanRoutes } from './routes.ts';
import { ALLOWED, kanbanTools } from './tools.ts';
import { migrateToBoards } from './migrate.ts';
import { COLUMNS } from './types.ts';

const WATCH_DELAY_MS = 300;
const REFERENCE = join(import.meta.dirname, '..', 'reference.md');

// In a work tab's system prompt: the board is the user's, so a card appears only after a yes.
export const KANBAN_RULE = 'Done work, follow-ups, named tasks: offer once to add or update a Claude OS kanban card; never add one unasked.';
const ROOT_RULE = `Kanban: card ids like \`OS-21\`, the user names tasks by them. Call \`take_kanban_card\` when you start a card; only the user deletes cards. After done or follow-up work, or a task the user names, you may ask once to add or update a card; never add one unasked. Read ${REFERENCE} before other board work.`;

// The interface's catalog: one source for the column names on screen and in the move tool's description.
const { STRINGS } = createRequire(import.meta.url)('../ui/strings.js') as { STRINGS: Record<string, Record<string, string>> };
const words = (language: string) => STRINGS[language] ?? STRINGS.en;
export const columnLabels = (language: string) => COLUMNS.map((c) => `${c} "${words(language)[`col.${c}`]}"`).join(', ');
const boardName = (language: string, id: string) => words(language)[`board.${id}`] ?? id;

// The folder as it was before Kanban+ first wrote to it, once: the format is the built-in board's, but nothing is risked.
function backupOnce(host: PluginHost, dir: string) {
  const marker = join(host.paths.data, 'backed-up');
  if (existsSync(marker) || !existsSync(dir)) return;
  cpSync(dir, join(host.paths.backups, `kanban-before-kanban-plus-${new Date().toISOString().replace(/[:.]/g, '-')}`), { recursive: true });
  writeFileSync(marker, new Date().toISOString());
}

// Obsidian writes these files too. Started when the folder exists: looking at the board must not create the vault.
function folderWatch(host: PluginHost, dir: string) {
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = () => {
    if (watcher || !existsSync(dir)) return;
    watcher = watch(dir, (_event, name) => {
      if (name?.startsWith('.')) return; // temp files, the trash and the logs
      timer ??= setTimeout(() => {
        timer = null;
        host.invalidate();
      }, WATCH_DELAY_MS);
      timer.unref();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null; // the folder went away: the next look at the board starts again
    });
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
  return { start, stop };
}

export function activate(host: PluginHost): PluginServer {
  const dir = join(host.paths.vault, 'kanban');
  backupOnce(host, dir);
  migrateToBoards(dir, host.parseFrontmatter, host.paths.backups);
  const board = createKanban(dir, {
    projects: host.projects,
    frontmatter: host.parseFrontmatter,
    osProject: host.osProject,
    legacy: join(host.paths.app, 'kanban.json'),
    sessionOf: (tab) => host.tabs().find((t) => t.id === tab)?.sessionId ?? null,
  });
  const watcher = folderWatch(host, dir);
  return {
    routes: kanbanRoutes(host, board, watcher.start),
    tools: (who) => kanbanTools(host, board, who, { columns: columnLabels, board: boardName }),
    allowed: ALLOWED,
    rules: { work: KANBAN_RULE, root: ROOT_RULE },
    dirs: [dir],
    views: ['kanban'],
    sessionStarted: (tabId, sessionId) => {
      if (board.recordSession(tabId, sessionId)) host.invalidate();
    },
    dispose: watcher.stop,
  };
}
