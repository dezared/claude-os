// A plugin's own data: JSON files under data/os-plugin-data/<id>, open to the plugin's interface code through its `data`
// permission. Its MCP server writes the same folder directly (it gets the path as {pluginData}); the watcher tells the interface.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { watch } from 'chokidar';
import type { OsPluginPermission } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';
import { NAME } from './osPluginManifest.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const SEGMENT = /^[\w-][\w.-]*$/; // no dot files, nothing that climbs out
const PLUGIN_DATA = '{pluginData}';

export const pluginDataDir = (ctx: Pick<Ctx, 'paths'>, id: string) => join(ctx.paths.data, 'os-plugin-data', id);

/** `{pluginData}` in a command, an argument or an env value, as `{pluginDir}` already is. */
export function withPluginData<T>(spec: T, dir: string): T {
  return JSON.parse(JSON.stringify(spec).replaceAll(PLUGIN_DATA, dir.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))) as T;
}

function relPath(raw: string, file: boolean): string[] {
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((p) => !SEGMENT.test(p))) throw httpError(400, 'bad data path');
  if (file && (parts.length === 0 || !parts.at(-1)!.endsWith('.json'))) throw httpError(400, 'only .json files');
  return parts;
}

function writeWhole(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** A JSON file's value, or a folder's listing of what the routes can reach. */
function read(path: string) {
  if (!existsSync(path)) throw httpError(404, 'not found');
  if (statSync(path).isDirectory()) {
    const entries = readdirSync(path, { withFileTypes: true }).filter((e) => SEGMENT.test(e.name) && (e.isDirectory() || e.name.endsWith('.json')));
    return { entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (!path.endsWith('.json')) throw httpError(404, 'not found');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function registerOsPluginData(ctx: Ctx, allows: (permission: OsPluginPermission, id?: string) => boolean, folders: () => { id: string; source: 'shipped' | 'user' }[]) {
  const root = join(ctx.paths.data, 'os-plugin-data');
  mkdirSync(root, { recursive: true });

  function place(id: string, raw: string, file: boolean): string {
    if (!NAME.test(id) || !allows('data', id)) throw httpError(403, `${id} does not hold the data permission`);
    return join(pluginDataDir(ctx, id), ...relPath(raw, file));
  }

  type DataReq = { Params: { id: string; '*': string } };
  ctx.app.get<DataReq>('/api/os-plugins/:id/data/*', async (req) => {
    const path = place(req.params.id, req.params['*'], false);
    if (path === pluginDataDir(ctx, req.params.id)) mkdirSync(path, { recursive: true });
    return read(path);
  });
  ctx.app.put<DataReq & { Body: unknown }>('/api/os-plugins/:id/data/*', { bodyLimit: MAX_BYTES }, async (req) => {
    const path = place(req.params.id, req.params['*'], true);
    writeWhole(path, JSON.stringify(req.body ?? null, null, 2) + '\n');
    ctx.audit('os-plugin.data', `${req.params.id}/${req.params['*']}`);
    ctx.invalidate('osPluginData');
    return { ok: true };
  });
  ctx.app.delete<DataReq>('/api/os-plugins/:id/data/*', async (req) => {
    const path = place(req.params.id, req.params['*'], false);
    if (path === pluginDataDir(ctx, req.params.id)) throw httpError(400, 'the data folder itself stays');
    rmSync(path, { recursive: true, force: true });
    ctx.audit('os-plugin.data-delete', `${req.params.id}/${req.params['*']}`);
    ctx.invalidate('osPluginData');
    return { ok: true };
  });

  // A folder for the work its Claude tabs do (a tab needs a cwd that exists): ~/<id>, or one folder inside it, made when the
  // plugin's screen opens such a tab. A POST, so nothing that only looks creates it; and only for a shipped plugin, whose id is
  // known not to name some other folder.
  ctx.app.post<{ Params: { id: string }; Body: { folder?: unknown } | null }>('/api/os-plugins/:id/workspace', async (req) => {
    place(req.params.id, '', false); // the permission check
    if (!folders().some((f) => f.id === req.params.id && f.source === 'shipped')) throw httpError(403, 'only a plugin that ships with Claude OS gets a workspace');
    const folder = req.body?.folder;
    if (folder !== undefined && (typeof folder !== 'string' || !SEGMENT.test(folder))) throw httpError(400, 'folder must be one folder name');
    const path = join(homedir(), req.params.id, ...(folder === undefined ? [] : [folder]));
    mkdirSync(path, { recursive: true });
    return { path };
  });

  // What a plugin's MCP server writes reaches the open screens too.
  const watcher = watch(root, { ignoreInitial: true, depth: 6 }).on('all', () => ctx.invalidate('osPluginData'));
  ctx.app.addHook('onClose', async () => { await safely(() => watcher.close(), undefined); });
}
