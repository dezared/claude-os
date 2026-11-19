// The board app's routes, under /api/plugins/kanban-plus. The user acts here, so the log says "user".
import type { PluginHost, PluginRequest, PluginRoute } from '../../../server/tools/pluginServerApi.ts';
import { USER, type Kanban } from './board.ts';
import type { CardInput } from './fields.ts';
import type { BoardInput } from './boards.ts';
import { GENERAL_BOARD, type Activity, type Card } from './types.ts';

export interface CardSession { id: string; title: string | null; project: string | null; cwd: string; lastActivity: number | null; tokens: number; costUsd: number | null; tab: string | null; working: boolean }

/** The sessions the card was worked in, from its file and its log, newest first, with what each spent. */
export function cardSessions(host: PluginHost, card: Card, log: Activity[]): CardSession[] {
  const ids = [...new Set([...(card.sessions ?? []), ...log.flatMap((a) => (a.session ? [a.session] : []))])];
  const tabs = host.tabs();
  return host.sessions(ids).map((s) => {
    const tab = tabs.find((t) => t.sessionId === s.id) ?? null;
    return { id: s.id, title: s.title ?? s.name ?? s.lastPrompt, project: s.project, cwd: s.cwd, lastActivity: s.lastActivity, tokens: s.tokens.input + s.tokens.output + s.tokens.cacheWrite, costUsd: s.costUsd, tab: tab?.id ?? null, working: tab?.status === 'working' };
  }).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}

type Handler = (req: PluginRequest & { body: Record<string, unknown> }) => unknown;

export function kanbanRoutes(host: PluginHost, board: Kanban, watch: () => void): PluginRoute[] {
  // A change refreshes every screen that shows the board; looking at it starts the watch on the folder.
  const changed = <T>(value: T) => {
    host.invalidate();
    watch();
    return value;
  };
  const body = (req: PluginRequest) => (req.body ?? {}) as Record<string, unknown>;
  const route = (method: PluginRoute['method'], path: string, handler: Handler): PluginRoute => ({ method, path, handler: (req) => handler({ ...req, body: body(req) }) });
  return [
    route('GET', '/board', () => {
      watch();
      return { path: board.dir, cards: board.list(), boards: board.boards(), prefixes: board.prefixes(), osProject: host.osProject() };
    }),
    route('POST', '/cards', (req) => changed(board.add(req.body as CardInput))),
    route('GET', '/cards/:id', (req) => {
      const detail = board.detail(req.params.id);
      return { ...detail, sessions: cardSessions(host, detail.card, detail.log) };
    }),
    route('PATCH', '/cards/:id', (req) => changed(board.update(req.params.id, req.body as CardInput))),
    route('POST', '/cards/:id/move', (req) => changed(board.move(req.params.id, { column: req.body.column, before: req.body.before, board: req.body.board }))),
    route('POST', '/cards/:id/take', (req) => changed(board.take(req.params.id, req.body.agent, { by: String(req.body.agent ?? USER.by), tab: typeof req.body.tab === 'string' ? req.body.tab : null }))),
    route('POST', '/cards/:id/comments', (req) => changed(board.comment(req.params.id, req.body.text))),
    route('DELETE', '/cards/:id', (req) => {
      board.remove(req.params.id);
      host.audit('delete', req.params.id);
      return changed({ ok: true });
    }),
    route('PUT', '/prefix', (req) => {
      const prefix = board.setPrefix(req.body.project ?? null, req.body.prefix);
      host.audit('prefix', String(req.body.project ?? GENERAL_BOARD), prefix);
      return changed({ prefix, prefixes: board.prefixes() });
    }),
    route('POST', '/boards', (req) => changed(board.addBoard(req.body as BoardInput))),
    route('PATCH', '/boards/:id', (req) => changed(board.updateBoard(req.params.id, req.body as BoardInput))),
    route('DELETE', '/boards/:id', (req) => {
      board.removeBoard(req.params.id);
      host.audit('board.delete', req.params.id);
      return changed({ ok: true });
    }),
  ];
}
