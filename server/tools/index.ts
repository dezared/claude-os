import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Ctx } from '../context.ts';
import { safely, sha256 } from '../memory/util.ts';
import type { HomeLayout, Profile, ProjectSettings, PromoteRequest, UniverseOptions } from '../../shared/contract.ts';
import { createAccount } from './account.ts';
import { createActions, type RunBody } from './actions.ts';
import { createAdmin, registerAdmin } from './admin.ts';
import { createOsPlugins } from './osPlugins.ts';
import { createProjectKit } from './projectKit.ts';
import { createProjectIcons } from './projectIcons.ts';
import { registerPlanner } from './planner.ts';
import { registerAgents } from './agents.ts';
import { registerDocuments } from './documents.ts';
import { registerKanban } from './kanban.ts';
import { registerProjectFiles } from './projectFiles.ts';
import { createClaudeMd } from './claudeMd.ts';
import { createCommands } from './commands.ts';
import { gitAmendInfo, gitBranches, gitCheckout, gitCommit, gitCommitDiff, gitCommitFiles, gitCompare, gitCompareDiff, gitCreateBranch, gitDeleteBranch, gitDiff, gitFetch, gitIgnore, gitLog, gitPull, gitPush, gitPushPreview, gitRenameBranch, gitRollback, gitStage, gitStashList, gitStashPop, gitStashPush, gitStatus, gitUnstage } from './git.ts';
import { listMicrotasks } from './microtasks.ts';
import { createSettings } from './settings.ts';
import { createSetup } from './setup.ts';
import { machineFacts, registerSetupRoutes, runSetupChecks, setupCheckDeps } from './setupChecks.ts';
import { createApprovals } from './approvals.ts';
import { createMcp } from './mcp.ts';
import { readClaudeJson } from './shared.ts';
import { createSkills } from './skills.ts';
import { createWidgets } from './widgets.ts';

const CLAUDE_JSON_POLL_MS = 5000;

function tabCwd(ctx: Ctx, id: string): string {
  if (!ctx.chat) throw Object.assign(new Error('chat is not running'), { statusCode: 503 });
  try {
    return ctx.chat.tabInfo(id).cwd;
  } catch (err) {
    throw Object.assign(err as Error, { statusCode: 404 });
  }
}

export function registerTools(ctx: Ctx): void {
  const { app } = ctx;
  mkdirSync(ctx.paths.config, { recursive: true });
  const approvals = createApprovals(ctx);
  const skills = createSkills(ctx);
  const mcp = createMcp(ctx);
  const actions = createActions(ctx, approvals);
  const widgets = createWidgets(ctx, approvals);
  const settings = createSettings(ctx, approvals);
  ctx.settings = { projectDefaults: settings.projectDefaults, profile: settings.profile, setProfile: settings.setProfile, setup: settings.setup, saveSetup: settings.saveSetup };
  const account = createAccount(ctx);
  const commands = createCommands(ctx, () => skills.list());
  const claudeMd = createClaudeMd(ctx);
  const setup = createSetup(ctx, skills, mcp);
  registerAdmin(ctx, createAdmin(ctx, skills, mcp, account));
  createProjectIcons(ctx);
  const osPlugins = createOsPlugins(ctx, skills, mcp, approvals);
  ctx.kit = createProjectKit(ctx, osPlugins.activeKit);

  registerPlanner(ctx);
  registerKanban(ctx);
  registerDocuments(ctx);
  registerAgents(ctx);
  registerProjectFiles(ctx, (id) => tabCwd(ctx, id), osPlugins.allows, (id) => safely(() => ctx.chat?.tabInfo(id).project ?? null, null));
  registerSetupRoutes(ctx, () => runSetupChecks(setupCheckDeps(ctx, () => account.status(true))), machineFacts(ctx, homedir()));

  app.get('/api/skills', async () => skills.list());
  app.post<{ Body: { id?: string; name?: string; content?: unknown } }>('/api/skills/preview', async (req) => skills.preview(req.body ?? {}));
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req) => skills.read(req.params.id));
  app.post<{ Body: { name?: unknown; content?: unknown } }>('/api/skills', async (req) => skills.create(req.body?.name, req.body?.content));
  app.put<{ Params: { id: string }; Body: { content?: unknown } }>('/api/skills/:id', async (req) => skills.update(req.params.id, req.body?.content));
  app.post<{ Params: { id: string } }>('/api/skills/:id/toggle', async (req) => skills.toggle(req.params.id));
  app.delete<{ Params: { id: string }; Body: { confirmed?: unknown } | null }>('/api/skills/:id', async (req) => skills.remove(req.params.id, req.body?.confirmed));

  app.get('/api/mcp', async () => mcp.list());
  app.post<{ Params: { name: string }; Body: { scope?: string; project?: string } | null }>('/api/mcp/:name/check', async (req) =>
    mcp.check(req.params.name, req.body?.scope, req.body?.project));
  app.post<{ Body: Record<string, unknown> }>('/api/mcp', async (req) => mcp.add(req.body ?? {}));
  app.delete<{ Params: { name: string }; Querystring: { scope?: string; project?: string } }>('/api/mcp/:name', async (req) => {
    await mcp.remove(req.params.name, req.query.scope, req.query.project);
    return { ok: true };
  });

  app.get('/api/actions', async () => actions.list());
  app.post<{ Params: { id: string }; Body: RunBody | null }>('/api/actions/:id/run', async (req, reply) => {
    try {
      return await actions.runAction(req.params.id, req.body ?? {});
    } catch (err) {
      const e = err as Error & { statusCode?: number; command?: string; sha256?: string };
      if (e.statusCode === 409 && e.command) return reply.code(409).send({ error: e.message, command: e.command, sha256: e.sha256 });
      throw err;
    }
  });
  app.post<{ Params: { id: string }; Body: { command?: unknown } | null }>('/api/actions/:id/approve', async (req) => actions.approve(req.params.id, req.body?.command));
  app.post<{ Body: RunBody | null }>('/api/open-terminal', async (req) => actions.runAction('builtin:terminal', req.body ?? {}));
  app.get<{ Querystring: RunBody }>('/api/open-terminal/preview', async (req) => actions.terminalPreview(req.query));

  app.get('/api/widgets', async () => widgets.list());
  app.post<{ Body: Record<string, unknown> }>('/api/widgets', async (req) => widgets.add(req.body ?? {}));
  app.delete<{ Params: { id: string } }>('/api/widgets/:id', async (req) => {
    widgets.remove(req.params.id);
    return { ok: true };
  });
  app.put<{ Params: { id: string }; Body: unknown }>('/api/widgets/:id/place', async (req) => widgets.place(req.params.id, req.body));
  app.post<{ Params: { id: string }; Body: { command?: unknown; view?: unknown } | null }>('/api/widgets/:id/approve', async (req) => widgets.approve(req.params.id, req.body?.command, req.body?.view));
  app.get<{ Params: { id: string } }>('/api/widgets/:id/view', async (req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store').send(widgets.viewModule(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/widgets/:id/view/source', async (req) => widgets.viewSource(req.params.id));

  app.get<{ Querystring: { refresh?: string } }>('/api/account', async (req) => account.status(req.query.refresh === '1'));
  app.get('/api/settings', async () => settings.view());
  app.put<{ Params: { key: string }; Body: ProjectSettings }>('/api/settings/project/:key', async (req) => settings.setProject(req.params.key, req.body ?? {}));
  app.put<{ Body: Partial<UniverseOptions> }>('/api/settings/universe', async (req) => settings.setUniverse(req.body ?? {}));
  app.put<{ Body: Partial<HomeLayout> }>('/api/settings/home', async (req) => settings.setHome(req.body ?? {}));
  app.put<{ Body: Partial<Profile> }>('/api/settings/profile', async (req) => settings.setProfile(req.body ?? {}));
  app.post('/api/settings/obsidian/dismiss', async () => settings.dismissObsidian());
  app.post('/api/settings/obsidian/recheck', async () => settings.recheckObsidian());
  app.post<{ Body: { url?: unknown } }>('/api/settings/obsidian/open', async (req) => {
    await settings.openObsidian(req.body?.url);
    return { ok: true };
  });
  app.post('/api/ides/scan', async () => settings.scan());
  app.post<{ Params: { id: string } }>('/api/ides/:id/approve', async (req) => settings.approve(req.params.id));
  app.get<{ Params: { key: string } }>('/api/ides/project/:key', async (req) => settings.forProject(req.params.key));
  app.post<{ Body: { ide?: unknown; project?: unknown; cwd?: unknown; file?: unknown } }>('/api/ides/open', async (req) => {
    await settings.open(req.body ?? {});
    return { ok: true };
  });

  app.post('/api/doctor', async () => commands.doctor());

  type TabReq = { Params: { id: string } };
  app.get<TabReq>('/api/tabs/:id/commands', async (req) => {
    tabCwd(ctx, req.params.id);
    return commands.forTab(req.params.id);
  });
  app.get<TabReq>('/api/tabs/:id/git', async (req) => gitStatus(tabCwd(ctx, req.params.id)));
  app.get<TabReq & { Querystring: { path?: string; area?: string } }>('/api/tabs/:id/git/diff', async (req) => gitDiff(tabCwd(ctx, req.params.id), req.query.path, req.query.area));
  app.get<{ Params: { id: string; hash: string } }>('/api/tabs/:id/git/commit/:hash', async (req) => gitCommitFiles(tabCwd(ctx, req.params.id), req.params.hash));
  app.get<{ Params: { id: string; hash: string }; Querystring: { path?: string } }>('/api/tabs/:id/git/commit/:hash/diff', async (req) => gitCommitDiff(tabCwd(ctx, req.params.id), req.params.hash, req.query.path));
  const gitWrite = (action: string, cwd: string, target: string, output: string) => {
    ctx.audit(`git.${action}`, cwd, `${target}\n${output}`.trim());
    return { ok: true, output };
  };
  app.post<TabReq & { Body: { paths?: unknown } }>('/api/tabs/:id/git/stage', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('stage', cwd, String(req.body?.paths), await gitStage(cwd, req.body?.paths));
  });
  app.post<TabReq & { Body: { paths?: unknown } }>('/api/tabs/:id/git/unstage', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('unstage', cwd, String(req.body?.paths), await gitUnstage(cwd, req.body?.paths));
  });
  app.post<TabReq & { Body: { message?: unknown; amend?: unknown; pushedConfirmed?: unknown } }>('/api/tabs/:id/git/commit', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite(req.body?.amend === true ? 'amend' : 'commit', cwd, String(req.body?.message), await gitCommit(cwd, req.body?.message, req.body ?? {}));
  });
  app.get<TabReq>('/api/tabs/:id/git/amend', async (req) => gitAmendInfo(tabCwd(ctx, req.params.id)));
  app.get<TabReq>('/api/tabs/:id/git/branches', async (req) => gitBranches(tabCwd(ctx, req.params.id)));
  app.get<TabReq & { Querystring: { ref?: string } }>('/api/tabs/:id/git/compare', async (req) => gitCompare(tabCwd(ctx, req.params.id), req.query.ref));
  app.get<TabReq & { Querystring: { ref?: string; path?: string } }>('/api/tabs/:id/git/compare/diff', async (req) => gitCompareDiff(tabCwd(ctx, req.params.id), req.query.ref, req.query.path));
  app.get<TabReq & { Querystring: { limit?: string } }>('/api/tabs/:id/git/log', async (req) => gitLog(tabCwd(ctx, req.params.id), req.query.limit));
  app.get<TabReq>('/api/tabs/:id/git/stash', async (req) => gitStashList(tabCwd(ctx, req.params.id)));
  app.post<TabReq>('/api/tabs/:id/git/fetch', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('fetch', cwd, '', await gitFetch(cwd));
  });
  app.post<TabReq>('/api/tabs/:id/git/pull', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('pull', cwd, '', await gitPull(cwd));
  });
  app.post<TabReq & { Body: { branch?: unknown } }>('/api/tabs/:id/git/checkout', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('checkout', cwd, String(req.body?.branch), await gitCheckout(cwd, req.body?.branch));
  });
  app.post<TabReq & { Body: { name?: unknown; from?: unknown; checkout?: unknown } }>('/api/tabs/:id/git/branch/create', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('branch.create', cwd, String(req.body?.name), await gitCreateBranch(cwd, req.body?.name, req.body?.from, req.body?.checkout));
  });
  app.post<TabReq & { Body: { from?: unknown; to?: unknown } }>('/api/tabs/:id/git/branch/rename', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('branch.rename', cwd, `${String(req.body?.from)} -> ${String(req.body?.to)}`, await gitRenameBranch(cwd, req.body?.from, req.body?.to));
  });
  app.post<TabReq & { Body: { branch?: unknown } }>('/api/tabs/:id/git/branch/delete', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('branch.delete', cwd, String(req.body?.branch), await gitDeleteBranch(cwd, req.body?.branch));
  });
  app.post<TabReq & { Body: { path?: unknown } }>('/api/tabs/:id/git/rollback', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('rollback', cwd, String(req.body?.path), await gitRollback(cwd, req.body?.path));
  });
  app.post<TabReq & { Body: { path?: unknown } }>('/api/tabs/:id/git/ignore', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('ignore', cwd, String(req.body?.path), await gitIgnore(cwd, req.body?.path));
  });
  app.post<TabReq & { Body: { message?: unknown; untracked?: unknown } }>('/api/tabs/:id/git/stash', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('stash', cwd, String(req.body?.message), await gitStashPush(cwd, req.body?.message, req.body?.untracked));
  });
  app.post<TabReq & { Body: { ref?: unknown } }>('/api/tabs/:id/git/stash/pop', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('stash.pop', cwd, String(req.body?.ref), await gitStashPop(cwd, req.body?.ref));
  });
  app.get<TabReq>('/api/tabs/:id/git/push', async (req) => gitPushPreview(tabCwd(ctx, req.params.id)));
  app.post<TabReq & { Body: { branch?: unknown; remote?: unknown; ahead?: unknown; publish?: unknown } }>('/api/tabs/:id/git/push', async (req) => {
    const cwd = tabCwd(ctx, req.params.id);
    return gitWrite('push', cwd, `${String(req.body?.branch)} -> ${String(req.body?.remote)}`, await gitPush(cwd, req.body ?? {}));
  });

  app.get<{ Querystring: { project?: string } }>('/api/claude-md', async (req) => claudeMd.report(req.query.project || null));
  app.post<{ Body: { scope?: unknown; project?: string } }>('/api/claude-md/open', async (req) => {
    const file = claudeMd.pathFor(req.body?.scope, req.body?.project);
    if (!file) throw Object.assign(new Error('unknown file'), { statusCode: 400 });
    await settings.open({ file, project: req.body?.project });
    return { ok: true };
  });

  app.post<{ Body: { scope?: unknown; project?: unknown; content?: unknown } }>('/api/claude-md/preview', async (req) => claudeMd.preview(req.body ?? {}));
  app.put<{ Body: { scope?: unknown; project?: unknown; content?: unknown; version?: unknown } }>('/api/claude-md', async (req) => claudeMd.save(req.body ?? {}));

  app.get('/api/microtasks', async () => listMicrotasks(ctx));

  type KeyReq = { Params: { key: string } };
  app.get<KeyReq>('/api/projects/:key/setup', async (req) => setup.view(req.params.key));
  app.post<KeyReq & { Body: { scope?: unknown; text?: unknown } }>('/api/projects/:key/setup/preview', async (req) => setup.preview(req.params.key, req.body?.scope, req.body?.text));
  app.put<KeyReq & { Params: { scope: string }; Body: { text?: unknown } }>('/api/projects/:key/setup/:scope', async (req) => setup.save(req.params.key, req.params.scope, req.body?.text));
  app.post<KeyReq & { Body: PromoteRequest }>('/api/projects/:key/promote/preview', async (req) => setup.promotePreview(req.params.key, req.body));
  app.post<KeyReq & { Body: PromoteRequest & { confirmed?: unknown } }>('/api/projects/:key/promote', async (req) => setup.promote(req.params.key, req.body));

  // Terminal sessions change the numbers too; the server's TTL keeps this from spawning a process per event.
  ctx.bus.on('rate-limit', () => ctx.invalidate('account'));
  ctx.bus.on('turn-finished', () => ctx.invalidate('account', 'usage'));
  ctx.bus.on('sessions-changed', () => ctx.invalidate('account'));

  const watchers: FSWatcher[] = [];

  let configTimer: NodeJS.Timeout | null = null;
  // One level down for config/widgets/*.js: a changed view needs its approval again.
  watchers.push(watch(ctx.paths.config, { ignoreInitial: true, depth: 1 }).on('all', (_event, path) => {
    const name = relative(ctx.paths.config, path);
    const isView = name.startsWith(`widgets${sep}`) && name.endsWith('.js');
    if (name !== 'actions.json' && name !== 'widgets.json' && name !== 'settings.json' && !isView) return;
    configTimer ??= setTimeout(() => {
      configTimer = null;
      widgets.reload();
      ctx.invalidate('actions', 'widgets', 'settings');
    }, 100);
    configTimer.unref();
  }));

  const skillRoots = [join(ctx.paths.claudeDir, 'skills'), join(ctx.paths.claudeDir, 'skills-disabled')];
  const skillsChanged = () => {
    commands.invalidate();
    ctx.invalidate('skills', 'overview');
  };
  for (const root of skillRoots) {
    watchers.push(watch(root, {
      ignoreInitial: true,
      depth: 1,
      followSymlinks: false,
      ignored: (p) => relative(root, p).split(sep).some((part) => part === 'synced' || part.startsWith('.')),
    }).on('all', skillsChanged));
  }

  // Claude Code rewrites ~/.claude.json constantly, so only a change in the parts shown here counts.
  const fingerprint = () => {
    const j = readClaudeJson(ctx);
    const mcpPart = { user: j.mcpServers, projects: Object.entries(j.projects ?? {}).map(([k, v]) => [k, v.mcpServers]) };
    return [sha256(JSON.stringify(mcpPart)), sha256(JSON.stringify(j.skillUsage ?? {}))];
  };
  let lastPrint = safely(fingerprint, ['', '']);
  const poll = setInterval(() => {
    const next = safely(fingerprint, lastPrint);
    if (next[0] !== lastPrint[0]) ctx.invalidate('mcp', 'overview');
    if (next[1] !== lastPrint[1]) ctx.invalidate('skills');
    lastPrint = next;
  }, CLAUDE_JSON_POLL_MS);
  poll.unref();

  widgets.reload();

  app.addHook('onClose', async () => {
    clearInterval(poll);
    if (configTimer) clearTimeout(configTimer);
    widgets.close();
    await Promise.all(watchers.map((w) => w.close()));
  });
}
