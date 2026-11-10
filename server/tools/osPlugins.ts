// Claude OS plugins: a folder in plugins/ (shipped) or config/plugins (the user's, wins by id) with a manifest, bundling skills, hooks, MCP servers and interface code, and naming what it needs from outside.
// Listing only reads. Nothing is installed or run until the user confirms the exact plan of changes in the interface.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { watch } from 'chokidar';
import { type OsPluginChange, type OsPluginContents, type OsPluginDependency, type OsPluginPermission, type OsPluginPlan, type OsPluginRow, type OsPluginSetup, type OsPluginsReport, type OsPluginUi } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { backupFile, httpError, safely, sha256, unifiedDiff } from '../memory/util.ts';
import type { Approvals } from './approvals.ts';
import { publicServer, type createMcp } from './mcp.ts';
import { MANIFEST, NAME, fence, isObj, isUiFile, text, treeHash, validateManifest, walk, type DependencySpec, type HookSpec, type Manifest, type Obj, type ServerSpec, type UiSpec } from './osPluginManifest.ts';
import { renderLibraryIcon } from './projectIcons.ts';
import { maskValue, readObject } from './setup.ts';
import type { createSkills } from './skills.ts';
import { readClaudeJson, readJson } from './shared.ts';

export { MANIFEST, treeHash, validateManifest, type Manifest };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const PROBE_MS = 800;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

interface Installed {
  version: string;
  at: number;
  tree: string;
  skills: { name: string; tree: string }[];
  hooks: { event: string; entry: Obj }[];
  mcp: { name: string; config: ServerSpec }[];
  settingsCreated: boolean;
  ui?: UiSpec | null; // absent in what older versions enabled
  kit?: string | null;
}

/** Where the block sits in a file, wherever Claude put it. */
function findBlock(file: string, plugin: string, dep: string): { from: number; to: number; text: string } | null {
  const [start, end] = fence(plugin, dep);
  const from = file.indexOf(start);
  const close = from < 0 ? -1 : file.indexOf(end, from);
  return close < 0 ? null : { from, to: close + end.length, text: file.slice(from, close + end.length) };
}

function cutBlock(file: string, at: { from: number; to: number }): string {
  const before = file.slice(0, at.from).trimEnd();
  const after = file.slice(at.to).trimStart();
  const joined = before && after ? `${before}\n\n${after}` : before || after;
  return joined && !joined.endsWith('\n') ? `${joined}\n` : joined;
}


const contentsOf = (m: Manifest): OsPluginContents => ({
  skills: m.skills,
  hooks: m.hooks.map((h) => ({ ...h, command: String(maskValue(h.command, 'command')) })),
  mcp: Object.entries(m.mcp).map(([name, config]) => {
    const pub = publicServer(name, 'user', null, config);
    return { name, summary: pub.summary, envKeys: pub.envKeys };
  }),
  ui: m.ui,
  kit: m.kit,
});
type BarePlan = Omit<OsPluginPlan, 'dependencies' | 'setup'>;
const uiDetail = (ui: UiSpec) => `${ui.entry}${ui.permissions.length ? `; ${ui.permissions.join(', ')}` : ''}`;

const hookEntry = (h: HookSpec): Obj => ({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command }] });
const hookLabel = (event: string, matcher: unknown) => `${event}${typeof matcher === 'string' && matcher ? ` · ${matcher}` : ''}`;
const entryCommand = (entry: Obj) => (Array.isArray(entry.hooks) && isObj(entry.hooks[0]) ? String(entry.hooks[0].command) : '');
// The CLI fills in defaults when it stores a server: those do not make it a different server.
const serverCore = (config: unknown) => {
  const c = isObj(config) ? config : {};
  return { command: c.command, url: c.url, args: c.args ?? [], env: c.env ?? {}, headers: c.headers ?? {} };
};
const serverDetail = (name: string, config: ServerSpec) => {
  const pub = publicServer(name, 'user', null, config);
  return `${pub.summary}${pub.envKeys.length ? `; env: ${pub.envKeys.join(', ')}` : ''}`;
};

function checkConfirm(body: { confirmed?: unknown; sha?: unknown } | null, sha: string, conflicts: string[]) {
  if (body?.confirmed !== true) throw httpError(400, 'confirmed: true is required');
  if (body.sha !== sha) throw httpError(409, 'the plugin changed: review it again');
  if (conflicts.length) throw httpError(409, conflicts.join('; '));
}

export function createOsPlugins(ctx: Ctx, skills: ReturnType<typeof createSkills>, mcp: ReturnType<typeof createMcp>, approvals: Approvals) {
  const dir = join(ctx.paths.config, 'plugins');
  const shippedDir = ctx.paths.plugins;
  const stateFile = join(ctx.paths.data, 'os-plugins.json');
  const claudeMd = join(ctx.paths.claudeDir, 'CLAUDE.md');
  const settingsFile = join(ctx.paths.claudeDir, 'settings.json');
  const skillPlaces = (name: string) => [join(ctx.paths.claudeDir, 'skills', name), join(ctx.paths.claudeDir, 'skills-disabled', name)];
  mkdirSync(dir, { recursive: true });

  const readState = () => readJson<Record<string, Installed>>(stateFile) ?? {};
  function writeState(state: Record<string, Installed>) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, pretty(state), { mode: 0o600 });
  }

  const folders = (base: string) => safely(() => readdirSync(base), []).filter((n) => !n.startsWith('.'));
  // State is keyed by id and the tree hash ignores where the folder is, so a plugin can move between the two places.
  function pluginFolders(): { id: string; dir: string; source: 'shipped' | 'user' }[] {
    const user = folders(dir).map((id) => ({ id, dir: join(dir, id), source: 'user' as const }));
    const shipped = folders(shippedDir).filter((id) => !user.some((u) => u.id === id)).map((id) => ({ id, dir: join(shippedDir, id), source: 'shipped' as const }));
    return [...user, ...shipped];
  }
  const folderOf = (id: string) => pluginFolders().find((f) => f.id === id) ?? { id, dir: join(dir, id), source: 'user' as const };
  const empty: OsPluginContents = { skills: [], hooks: [], mcp: [], ui: null, kit: null };

  const targetOf = (d: DependencySpec, plugin: string) => {
    if (d.kind === 'config') return claudeMd;
    if (d.kind !== 'download') return d.target;
    return d.target.replace('{claudeDir}', ctx.paths.claudeDir).replace('{pluginData}', join(ctx.paths.data, 'os-plugin-data', plugin));
  };

  // Only looks. An address is asked only on this machine: a listed plugin gets no way to call out through the server.
  async function stateOf(d: DependencySpec, plugin: string): Promise<OsPluginDependency['state']> {
    const target = targetOf(d, plugin);
    if (d.kind === 'config') return findBlock(safely(() => readFileSync(target, 'utf8'), ''), plugin, d.id) ? 'met' : 'missing';
    if (d.kind === 'download') return existsSync(target) ? 'met' : 'missing';
    if (d.kind === 'package') {
      const names = process.platform === 'win32' ? [`${target}.exe`, `${target}.cmd`, target] : [target];
      return (process.env.PATH ?? '').split(delimiter).some((p) => p && names.some((n) => existsSync(join(p, n)))) ? 'met' : 'missing';
    }
    if (!LOOPBACK.test(target)) return 'unknown';
    return fetch(target, { signal: AbortSignal.timeout(PROBE_MS) }).then((r) => (r.ok ? 'met' : 'missing'), () => 'missing');
  }

  function setupOf(m: Manifest, folder: string, deps: OsPluginDependency[]): OsPluginSetup | null {
    const todo = m.dependencies.filter((d) => deps.find((x) => x.id === d.id)?.state === 'missing');
    if (todo.length === 0) return null;
    const steps = todo.map((d, i) => {
      const head = `${i + 1}. ${d.title} (${d.kind}, ${d.level}). ${d.why}`;
      if (d.kind === 'config') return `${head}\nAdd this block to ${claudeMd}, creating the file if there is none. Read the file first and choose where the block fits best. Keep the block exactly as it is, the two marker lines included, and change nothing else in the file:\n\n${d.block}`;
      return `${head}\nTarget: ${targetOf(d, m.id)}\n${d.task}`;
    });
    return {
      cwd: ctx.paths.root,
      title: `${m.name}: setup`,
      prompt: [
        `The Claude OS plugin "${m.name}" (folder ${folder}) needs the following from outside its folder. Set up each item, then say in one line what changed.`,
        'The plugin itself is handled by Claude OS: do not enable it, disable it or edit its folder. Install things the usual way for this system and ask before anything that needs administrator rights.',
        ...steps,
      ].join('\n\n'),
    };
  }

  async function dependenciesOf(m: Manifest): Promise<OsPluginDependency[]> {
    return Promise.all(m.dependencies.map(async ({ task: _task, ...d }) => ({ ...d, target: targetOf({ ...d, task: null }, m.id), state: await stateOf({ ...d, task: null }, m.id) })));
  }

  async function row({ id, dir: path, source }: { id: string; dir: string; source: OsPluginRow['source'] }, installed: Installed | undefined): Promise<OsPluginRow> {
    const { manifest, errors, raw } = validateManifest(id, path);
    const dependencies = manifest ? await dependenciesOf(manifest) : [];
    return {
      id,
      name: manifest?.name ?? text(raw.name) ?? id,
      description: manifest?.description ?? text(raw.description),
      descriptionRu: manifest?.descriptionRu ?? text(raw.descriptionRu),
      features: manifest?.features ?? [],
      featuresRu: manifest?.featuresRu ?? [],
      icon: manifest?.icon ? await renderLibraryIcon(manifest.icon) : null,
      version: manifest?.version ?? text(raw.version),
      author: manifest?.author ?? text(raw.author),
      path,
      source,
      contains: manifest ? contentsOf(manifest) : empty,
      dependencies,
      setup: manifest ? setupOf(manifest, path, dependencies) : null,
      errors,
      enabled: !!installed,
      installedVersion: installed?.version ?? null,
      installedAt: installed?.at ?? null,
      changed: !!installed && treeHash(path) !== installed.tree,
    };
  }

  async function list(): Promise<OsPluginsReport> {
    const state = readState();
    const found = pluginFolders();
    const rows = await Promise.all(found.map((f) => row(f, state[f.id])));
    // The folder went away but what it installed did not: it still has to be possible to disable it.
    for (const [id, installed] of Object.entries(state)) {
      if (!found.some((f) => f.id === id)) rows.push({ ...(await row(folderOf(id), installed)), errors: ['the plugin folder is gone'], changed: false });
    }
    return { dir, rows: rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)) };
  }

  function planEnable(id: string, replacing?: Installed): BarePlan & { manifest: Manifest; folder: string } {
    if (!NAME.test(id)) throw httpError(400, 'bad plugin id');
    const folder = folderOf(id).dir;
    if (!existsSync(folder)) throw httpError(404, 'plugin not found');
    const { manifest, errors } = validateManifest(id, folder);
    if (!manifest) throw httpError(422, errors.join('; '));
    const changes: OsPluginChange[] = [];
    const conflicts: string[] = [];
    const leaving = replacing ? classify(replacing, id) : [];
    const ours = (kind: OsPluginChange['kind'], name: string) => leaving.some((c) => c.kind === kind && c.name === name && c.action === 'remove');
    if (!replacing && readState()[id]) conflicts.push('the plugin is already enabled');
    for (const name of manifest.skills) {
      const [target] = skillPlaces(name);
      if (skillPlaces(name).some(existsSync) && !ours('skill', name)) conflicts.push(`skill ${name} already exists`);
      changes.push({ kind: 'skill', action: 'add', name, where: target, detail: (walk(join(folder, 'skills', name)) ?? []).join(', ') });
    }
    const settings = readObject(settingsFile);
    if (settings.invalid && manifest.hooks.length) conflicts.push(`${settingsFile} is not valid JSON`);
    const current = isObj(settings.value.hooks) ? settings.value.hooks : {};
    for (const h of manifest.hooks) {
      const list = current[h.event];
      if (Array.isArray(list) && list.some((e) => same(e, hookEntry(h))) && !ours('hook', hookLabel(h.event, h.matcher))) conflicts.push(`the hook ${hookLabel(h.event, h.matcher)} is already there`);
      changes.push({ kind: 'hook', action: 'add', name: hookLabel(h.event, h.matcher), where: settingsFile, detail: String(maskValue(h.command, 'command')) });
    }
    const users = readClaudeJson(ctx).mcpServers ?? {};
    for (const [name, config] of Object.entries(manifest.mcp)) {
      if (name in users && !ours('mcp', name)) conflicts.push(`MCP server ${name} already exists`);
      changes.push({ kind: 'mcp', action: 'add', name, where: `${ctx.paths.claudeJson} (mcpServers)`, detail: serverDetail(name, config) });
    }
    if (manifest.ui) changes.push({ kind: 'ui', action: 'add', name: manifest.name, where: join(folder, manifest.ui.entry), detail: uiDetail(manifest.ui) });
    // A kit writes nothing on enabling: it only makes the project kit actions available.
    if (manifest.kit) changes.push({ kind: 'kit', action: 'add', name: manifest.name, where: folder, detail: 'project kit actions' });
    // On an update what stays is named once, as what comes in; the interface part is only a pointer, nothing leaves with it.
    const gone = leaving.filter((c) => c.kind !== 'ui' && c.action === 'remove' && !changes.some((n) => n.kind === c.kind && n.name === c.name));
    const shown = [...gone, ...changes];
    return { id, action: replacing ? 'update' : 'enable', version: manifest.version, changes: shown, conflicts, sha: sha256(JSON.stringify({ changes: shown, tree: treeHash(folder), update: !!replacing })), manifest, folder };
  }

  // What is still as it was installed goes; what the user has changed since stays and is named in the plan.
  function classify(installed: Installed, id: string): OsPluginChange[] {
    const out: OsPluginChange[] = [];
    for (const s of installed.skills) {
      const place = skillPlaces(s.name).find((p) => safely(() => (lstatSync(p), true), false));
      out.push({ kind: 'skill', action: !place ? 'gone' : treeHash(place) === s.tree ? 'remove' : 'keep', name: s.name, where: place ?? skillPlaces(s.name)[0], detail: '' });
    }
    const hooks = readObject(settingsFile).value.hooks;
    for (const h of installed.hooks) {
      const list = isObj(hooks) ? hooks[h.event] : null;
      const there = Array.isArray(list) && list.some((e) => same(e, h.entry));
      out.push({ kind: 'hook', action: there ? 'remove' : 'gone', name: hookLabel(h.event, h.entry.matcher), where: settingsFile, detail: String(maskValue(entryCommand(h.entry), 'command')) });
    }
    const users = readClaudeJson(ctx).mcpServers ?? {};
    for (const m of installed.mcp) {
      out.push({ kind: 'mcp', action: !(m.name in users) ? 'gone' : same(serverCore(users[m.name]), serverCore(m.config)) ? 'remove' : 'keep', name: m.name, where: `${ctx.paths.claudeJson} (mcpServers)`, detail: serverDetail(m.name, m.config) });
    }
    if (installed.ui) out.push({ kind: 'ui', action: 'remove', name: installed.ui.entry, where: folderOf(id).dir, detail: uiDetail(installed.ui) });
    return out;
  }

  // What was reviewed is what runs: a folder changed after enabling stops counting until it is enabled again.
  const activeUi = () => Object.entries(readState()).flatMap(([id, installed]) => (
    installed.ui && treeHash(folderOf(id).dir) === installed.tree ? [{ id, tree: installed.tree, ui: installed.ui }] : []
  ));
  const allows = (permission: OsPluginPermission) => activeUi().some((p) => p.ui.permissions.includes(permission));
  // The same rule for a kit; `dir` is the folder of its templates.
  const activeKit = (): { id: string; dir: string; version: string } | null => Object.entries(readState()).flatMap(([id, installed]) => (
    installed.kit && treeHash(folderOf(id).dir) === installed.tree ? [{ id, dir: join(folderOf(id).dir, installed.kit), version: installed.version }] : []
  ))[0] ?? null;
  function uiList(): OsPluginUi[] {
    return activeUi().map((p) => ({
      id: p.id,
      name: validateManifest(p.id, folderOf(p.id).dir).manifest?.name ?? p.id,
      url: `/api/os-plugins/${encodeURIComponent(p.id)}/${p.tree}/${p.ui.entry}`,
    }));
  }

  // The block goes with the plugin as long as it is what the plugin brought: without the plugin it only misleads Claude.
  function blockChanges(id: string): OsPluginChange[] {
    const { manifest } = validateManifest(id, folderOf(id).dir);
    const file = safely(() => readFileSync(claudeMd, 'utf8'), '');
    return (manifest?.dependencies ?? []).flatMap((d) => {
      const found = d.kind === 'config' ? findBlock(file, id, d.id) : null;
      return found ? [{ kind: 'config' as const, action: found.text === d.block ? 'remove' as const : 'keep' as const, name: d.title, where: claudeMd, detail: '' }] : [];
    });
  }

  function removeBlocks(id: string) {
    const { manifest } = validateManifest(id, folderOf(id).dir);
    let file = safely(() => readFileSync(claudeMd, 'utf8'), '');
    const before = file;
    for (const d of manifest?.dependencies ?? []) {
      const found = d.kind === 'config' ? findBlock(file, id, d.id) : null;
      if (found && found.text === d.block) file = cutBlock(file, found);
    }
    if (file === before) return;
    backupFile(ctx.paths.data, claudeMd);
    writeFileSync(claudeMd, file);
    ctx.audit('os-plugin.claude-md', claudeMd, unifiedDiff(before, file, 'CLAUDE.md'));
  }

  function planDisable(id: string): BarePlan & { installed: Installed } {
    const installed = readState()[id];
    if (!installed) throw httpError(409, 'the plugin is not enabled');
    const changes = [...classify(installed, id), ...blockChanges(id)];
    return { id, action: 'disable', version: installed.version, changes, conflicts: [], sha: sha256(JSON.stringify(changes)), installed };
  }

  async function preview(id: unknown, action: unknown): Promise<OsPluginPlan> {
    if (typeof id !== 'string') throw httpError(400, 'bad plugin id');
    if (action === 'enable' || action === 'update') {
      const installed = action === 'update' ? readState()[id] : undefined;
      if (action === 'update' && !installed) throw httpError(409, 'the plugin is not enabled');
      const { manifest, folder, ...plan } = planEnable(id, installed);
      const dependencies = await dependenciesOf(manifest);
      return { ...plan, dependencies, setup: setupOf(manifest, folder, dependencies) };
    }
    if (action === 'disable') {
      const { installed: _i, ...plan } = planDisable(id);
      return { ...plan, dependencies: [], setup: null };
    }
    throw httpError(400, 'action must be enable, disable or update');
  }

  function writeSettings(next: Obj, action: string, target: string) {
    const before = readObject(settingsFile);
    backupFile(ctx.paths.data, settingsFile);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, pretty(next));
    ctx.audit(action, target, unifiedDiff(before.exists ? pretty(maskValue(before.value)) : '', pretty(maskValue(next)), 'settings.json'));
  }

  function addHooks(entries: { event: string; entry: Obj }[], id: string) {
    const { value, invalid } = readObject(settingsFile);
    if (invalid) throw httpError(409, `${settingsFile} is not valid JSON`);
    const hooks = isObj(value.hooks) ? value.hooks : {};
    for (const { event, entry } of entries) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), entry];
    writeSettings({ ...value, hooks }, 'os-plugin.hooks', id);
  }

  function removeHooks(installed: Installed, id: string) {
    const { value, invalid } = readObject(settingsFile);
    if (invalid || !isObj(value.hooks)) return;
    const next = structuredClone(value);
    const hooks = next.hooks as Obj;
    for (const { event, entry } of installed.hooks) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      const at = list.findIndex((e) => same(e, entry));
      if (at < 0) continue;
      list.splice(at, 1);
      if (list.length === 0) delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete next.hooks;
    if (same(next, value)) return;
    writeSettings(next, 'os-plugin.hooks', id);
    if (installed.settingsCreated && Object.keys(next).length === 0) unlinkSync(settingsFile);
  }

  async function uninstall(installed: Installed, id: string) {
    const changes = classify(installed, id);
    const removing = (kind: OsPluginChange['kind'], name: string) => changes.find((c) => c.kind === kind && c.name === name && c.action === 'remove');
    for (const s of installed.skills) {
      const change = removing('skill', s.name);
      if (!change) continue;
      backupFile(ctx.paths.data, join(change.where, 'SKILL.md'));
      rmSync(change.where, { recursive: true });
      ctx.audit('skill.remove', change.where, `os-plugin ${id}`);
    }
    if (installed.hooks.length) removeHooks(installed, id);
    for (const m of installed.mcp) if (removing('mcp', m.name)) await mcp.remove(m.name, 'user');
    ctx.invalidate('skills', 'mcp', 'overview');
  }

  async function enable(id: string, body: { confirmed?: unknown; sha?: unknown } | null): Promise<OsPluginsReport> {
    const plan = planEnable(id);
    checkConfirm(body, plan.sha, plan.conflicts);
    return install(plan);
  }

  async function update(id: string, body: { confirmed?: unknown; sha?: unknown } | null): Promise<OsPluginsReport> {
    const installed = readState()[id];
    if (!installed) throw httpError(409, 'the plugin is not enabled');
    const plan = planEnable(id, installed);
    checkConfirm(body, plan.sha, plan.conflicts);
    await uninstall(installed, id);
    const { [id]: _old, ...rest } = readState();
    writeState(rest);
    return install(plan);
  }

  async function install(plan: ReturnType<typeof planEnable>): Promise<OsPluginsReport> {
    const { id, manifest, folder } = plan;
    const done: Installed = { version: manifest.version, at: Date.now(), tree: treeHash(folder)!, skills: [], hooks: [], mcp: [], settingsCreated: !existsSync(settingsFile), ui: manifest.ui, kit: manifest.kit };
    try {
      for (const name of manifest.skills) {
        const source = join(folder, 'skills', name);
        skills.create(name, readFileSync(join(source, 'SKILL.md'), 'utf8'));
        const [target] = skillPlaces(name);
        cpSync(source, target, { recursive: true });
        done.skills.push({ name, tree: treeHash(target)! });
      }
      if (manifest.hooks.length) {
        const entries = manifest.hooks.map((h) => ({ event: h.event, entry: hookEntry(h) }));
        addHooks(entries, id);
        done.hooks = entries;
      }
      for (const [name, config] of Object.entries(manifest.mcp)) {
        await mcp.add({ name, scope: 'user', json: config, confirmed: true });
        done.mcp.push({ name, config });
      }
    } catch (err) {
      await uninstall(done, id).catch((e: Error) => ctx.app.log.warn(e));
      throw err;
    }
    // The dialog just showed these commands: confirming it is the approval the rest of the app asks for.
    for (const h of manifest.hooks) approvals.approve(h.command, `os-plugin:${id}`);
    for (const config of Object.values(manifest.mcp)) if (config.command) approvals.approve([config.command, ...(config.args ?? []).map(String)].join(' '), `os-plugin:${id}`);
    writeState({ ...readState(), [id]: done });
    ctx.audit(`os-plugin.${plan.action}`, id, plan.changes.map((c) => `${c.action === 'add' ? '+' : '-'} ${c.kind} ${c.name} -> ${c.where}`).join('\n'));
    ctx.invalidate('osPlugins', 'skills', 'mcp', 'overview');
    return list();
  }

  async function disable(id: string, body: { confirmed?: unknown; sha?: unknown } | null): Promise<OsPluginsReport> {
    const plan = planDisable(id);
    checkConfirm(body, plan.sha, plan.conflicts);
    await uninstall(plan.installed, id);
    removeBlocks(id);
    const { [id]: _gone, ...rest } = readState();
    writeState(rest);
    ctx.audit('os-plugin.disable', id, plan.changes.map((c) => `${c.action} ${c.kind} ${c.name} (${c.where})`).join('\n'));
    ctx.invalidate('osPlugins', 'skills', 'mcp', 'overview');
    return list();
  }

  const watcher = watch([dir, shippedDir], { ignoreInitial: true, depth: 3 }).on('all', () => ctx.invalidate('osPlugins'));
  // A block Claude has just added is a dependency met.
  mkdirSync(ctx.paths.claudeDir, { recursive: true });
  const claudeMdWatcher = watch(ctx.paths.claudeDir, { ignoreInitial: true, depth: 0 }).on('all', (_event, path) => {
    if (basename(path) === basename(claudeMd)) ctx.invalidate('osPlugins');
  });
  ctx.app.addHook('onClose', async () => { await Promise.all([watcher.close(), claudeMdWatcher.close()]); });

  type IdReq = { Params: { id: string } };
  type ConfirmReq = IdReq & { Body: { confirmed?: unknown; sha?: unknown } | null };
  ctx.app.get('/api/os-plugins', async () => list());
  ctx.app.get('/api/os-plugins/ui', async () => uiList());
  ctx.app.get<{ Params: { id: string; tree: string; '*': string } }>('/api/os-plugins/:id/:tree/ui/*', async (req, reply) => {
    const rel = `ui/${req.params['*']}`;
    const known = activeUi().some((p) => p.id === req.params.id && p.tree === req.params.tree);
    const file = join(folderOf(req.params.id).dir, rel);
    if (!known || !isUiFile(rel) || !existsSync(file)) throw httpError(404, 'not found');
    return reply.type('text/javascript').header('cache-control', 'no-store').send(readFileSync(file));
  });
  ctx.app.post<IdReq & { Body: { action?: unknown } | null }>('/api/os-plugins/:id/preview', async (req) => preview(req.params.id, req.body?.action));
  ctx.app.post<ConfirmReq>('/api/os-plugins/:id/enable', async (req) => enable(req.params.id, req.body));
  ctx.app.post<ConfirmReq>('/api/os-plugins/:id/disable', async (req) => disable(req.params.id, req.body));
  ctx.app.post<ConfirmReq>('/api/os-plugins/:id/update', async (req) => update(req.params.id, req.body));
  return { allows, activeKit };
}
