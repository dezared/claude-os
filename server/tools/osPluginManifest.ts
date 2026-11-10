// The Claude OS plugin manifest: what a plugin folder declares and how it is checked. Only reads the folder, never runs it.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { OS_PLUGIN_COMPONENTS, OS_PLUGIN_DEPENDENCY_KINDS, OS_PLUGIN_PERMISSIONS, type OsPluginDependency, type OsPluginDependencyKind, type OsPluginPermission } from '../../shared/contract.ts';
import { KIT_STACKS, type KitStack } from '../../shared/projectKit.ts';
import { safely, sha256 } from '../memory/util.ts';
import { libraryHas } from './projectIcons.ts';

export const MANIFEST = 'plugin.json';
export const NAME = /^[A-Za-z0-9][\w.-]*$/;
const VERSION = /^\d+\.\d+\.\d+([-+][\w.-]+)?$/;
const EVENT = /^[A-Z][A-Za-z]+$/;
const PLUGIN_DIR = '{pluginDir}';
const UI_FILE = /^ui(\/[\w.-]+)+\.js$/;
export const isUiFile = (rel: string) => UI_FILE.test(rel) && !rel.split('/').includes('..');
const CLAUDE_MD_TARGET = 'claude-md';
const DOWNLOAD_PLACE = /^\{(claudeDir|pluginData)\}\//;
// A kit is a fixed folder with an index, so the engine always knows where the templates are.
const KIT_DIR = 'kit';
const KIT_INDEX = 'files.json';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const texts = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => text(x) ?? []) : []);

export interface HookSpec { event: string; matcher: string | null; command: string }
export interface ServerSpec { command?: string; url?: string; args?: unknown[]; env?: Record<string, unknown>; headers?: Record<string, unknown> }
export interface UiSpec { entry: string; permissions: OsPluginPermission[] }
export interface DependencySpec {
  id: string;
  kind: OsPluginDependencyKind;
  level: OsPluginDependency['level'];
  title: string;
  titleRu: string | null;
  why: string;
  whyRu: string | null;
  target: string; // as the manifest has it; see targetOf
  block: string | null;
  task: string | null; // config has its own wording
}

export interface Manifest {
  id: string;
  name: string;
  description: string;
  descriptionRu: string | null;
  features: string[];
  featuresRu: string[];
  icon: string | null;
  version: string;
  author: string;
  dependencies: DependencySpec[];
  skills: string[];
  hooks: HookSpec[];
  mcp: Record<string, ServerSpec>;
  ui: UiSpec | null;
  kit: string | null;
}

/** A row of `kit/files.json`: a template and who owns the file it renders to; `stacks` and `when` limit where it applies. */
const KIT_WHEN = ['git', 'tests', 'migrate'] as const;
export interface KitTemplate { path: string; owner: 'kit' | 'seed'; stacks?: KitStack[]; when?: (typeof KIT_WHEN)[number] }

/** Files under a folder, sorted. Null when a symlink is found: a plugin is what is in its folder and nothing else. */
export function walk(dir: string, prefix = ''): string[] | null {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) {
      const sub = walk(join(dir, name), rel);
      if (!sub) return null;
      out.push(...sub);
    } else if (st.isFile()) out.push(rel);
    else return null;
  }
  return out;
}

export function treeHash(dir: string): string | null {
  const files = safely(() => (lstatSync(dir).isDirectory() ? walk(dir) : null), null);
  if (!files) return null;
  return sha256(files.map((f) => `${f}\0${sha256(readFileSync(join(dir, f)).toString('base64'))}`).join('\n'));
}

const marker = (plugin: string, dep: string) => `os-plugin:${plugin}:${dep}`;
export const fence = (plugin: string, dep: string) => [`<!-- ${marker(plugin, dep)}:start -->`, `<!-- ${marker(plugin, dep)}:end -->`] as const;
const fenced = (plugin: string, dep: string, body: string) => {
  const [start, end] = fence(plugin, dep);
  return `${start}\n${body}\n${end}`;
};


/** Where a dependency other than config points, and what a good value looks like. */
const TARGETS: Record<Exclude<OsPluginDependencyKind, 'config'>, { key: string; ok: (v: string) => boolean; why: string }> = {
  service: { key: 'url', ok: (v) => /^https?:\/\//.test(v), why: 'needs a url' },
  package: { key: 'bin', ok: (v) => NAME.test(v), why: 'needs a bin: the program to find on PATH' },
  download: { key: 'path', ok: (v) => DOWNLOAD_PLACE.test(v) && !v.split('/').includes('..'), why: 'needs a path under {claudeDir}/ or {pluginData}/: a file in the plugin folder would change what was reviewed' },
};

function configBlock(d: Obj, plugin: string, dir: string): { target: string; block: string } | string {
  const file = typeof d.block === 'string' ? d.block : '';
  if (d.file !== CLAUDE_MD_TARGET) return `file can only be ${CLAUDE_MD_TARGET}`;
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return 'block must be a file in the plugin folder';
  const body = safely(() => readFileSync(join(dir, file), 'utf8').trim(), '');
  if (!body) return `block file ${file} is missing or empty`;
  return { target: CLAUDE_MD_TARGET, block: fenced(plugin, String(d.id), body) };
}

function outsideTarget(d: Obj, kind: Exclude<OsPluginDependencyKind, 'config'>, task: string | null): { target: string; block: null } | string {
  const rule = TARGETS[kind];
  const value = d[rule.key];
  if (!task) return 'needs a task: what Claude has to do';
  if (typeof value !== 'string' || !rule.ok(value)) return rule.why;
  return { target: value, block: null };
}

function dependencyProblem(d: Obj, id: string, seen: DependencySpec[]): string | null {
  if (seen.some((x) => x.id === id)) return 'the id is used twice';
  if (!OS_PLUGIN_DEPENDENCY_KINDS.includes(d.kind as OsPluginDependencyKind)) return `kind can only be ${OS_PLUGIN_DEPENDENCY_KINDS.join(', ')}`;
  if (d.level !== undefined && d.level !== 'required' && d.level !== 'recommended') return 'level can only be required or recommended';
  if (!text(d.title) || !text(d.why)) return 'needs a title and why';
  return null;
}

/** One dependency, or what is wrong with it. */
function readDependency(d: unknown, seen: DependencySpec[], plugin: string, dir: string): DependencySpec | string {
  if (!isObj(d) || typeof d.id !== 'string' || !NAME.test(d.id)) return 'needs an id';
  const problem = dependencyProblem(d, d.id, seen);
  if (problem) return problem;
  const kind = d.kind as OsPluginDependencyKind;
  const task = text(d.task);
  const place = kind === 'config' ? configBlock(d, plugin, dir) : outsideTarget(d, kind, task);
  if (typeof place === 'string') return place;
  return { id: d.id, kind, level: d.level === 'recommended' ? 'recommended' : 'required', title: text(d.title)!, titleRu: text(d.titleRu), why: text(d.why)!, whyRu: text(d.whyRu), ...place, task };
}

function readDependencies(raw: unknown, plugin: string, dir: string, errors: string[]): DependencySpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('dependencies must be a list');
    return [];
  }
  const out: DependencySpec[] = [];
  for (const d of raw) {
    const read = readDependency(d, out, plugin, dir);
    if (typeof read === 'string') errors.push(`dependency ${isObj(d) ? String(d.id) : JSON.stringify(d)}: ${read}`);
    else out.push(read);
  }
  return out;
}

function checkIdentity(raw: Obj, folder: string, dir: string, errors: string[]) {
  if (raw.id !== folder) errors.push(`id must equal the folder name "${folder}"`);
  if (!NAME.test(folder)) errors.push('the folder name has characters an id cannot have');
  for (const field of ['name', 'description', 'author']) if (!text(raw[field])) errors.push(`${field} is required`);
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) errors.push('version must look like 1.2.3');
  if (treeHash(dir) === null) errors.push('symlinks are not allowed in a plugin');
}

function checkLooks(raw: Obj, errors: string[]) {
  if (raw.icon !== undefined && !(typeof raw.icon === 'string' && libraryHas(raw.icon))) errors.push(`icon ${String(raw.icon)} is not in the libraries: a lucide name or si:<slug>`);
  for (const field of ['features', 'featuresRu']) if (raw[field] !== undefined && !(Array.isArray(raw[field]) && raw[field].every((x) => text(x)))) errors.push(`${field} must be a list of lines`);
}

function readSkills(contains: Obj, dir: string, errors: string[]): string[] {
  const skills: string[] = [];
  if (contains.skills === undefined) return skills;
  if (!Array.isArray(contains.skills)) {
    errors.push('contains.skills must be a list of names');
    return skills;
  }
  for (const s of contains.skills) {
    if (typeof s !== 'string' || !NAME.test(s)) errors.push(`bad skill name ${String(s)}`);
    else if (!existsSync(join(dir, 'skills', s, 'SKILL.md'))) errors.push(`skills/${s}/SKILL.md is missing`);
    else skills.push(s);
  }
  return skills;
}

const isHook = (h: unknown): h is Obj => isObj(h) && typeof h.event === 'string' && EVENT.test(h.event) && !!text(h.command) && (h.matcher === undefined || typeof h.matcher === 'string');

function readHooks(contains: Obj, dir: string, errors: string[]): HookSpec[] {
  const hooks: HookSpec[] = [];
  if (contains.hooks === undefined) return hooks;
  if (!Array.isArray(contains.hooks)) {
    errors.push('contains.hooks must be a list');
    return hooks;
  }
  for (const h of contains.hooks) {
    if (!isHook(h)) errors.push(`bad hook ${JSON.stringify(h)}: needs event, command and an optional matcher`);
    else hooks.push({ event: h.event as string, matcher: (h.matcher as string | undefined) || null, command: (h.command as string).replaceAll(PLUGIN_DIR, dir) });
  }
  return hooks;
}

function readMcp(contains: Obj, dir: string, errors: string[]): Record<string, ServerSpec> {
  const mcp: Record<string, ServerSpec> = {};
  if (contains.mcp === undefined) return mcp;
  if (!isObj(contains.mcp)) {
    errors.push('contains.mcp must map server names to their config');
    return mcp;
  }
  for (const [name, config] of Object.entries(contains.mcp)) {
    if (!NAME.test(name)) errors.push(`bad server name ${name}`);
    else if (!isObj(config) || !(text(config.command) || text(config.url))) errors.push(`server ${name} needs a command or a url`);
    else mcp[name] = JSON.parse(JSON.stringify(config).replaceAll(PLUGIN_DIR, dir.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))) as ServerSpec;
  }
  return mcp;
}

function readUi(contains: Obj, dir: string, errors: string[]): UiSpec | null {
  const spec = contains.ui;
  if (spec === undefined) return null;
  const permissions = isObj(spec) ? spec.permissions ?? [] : [];
  if (!isObj(spec) || typeof spec.entry !== 'string' || !isUiFile(spec.entry)) errors.push('contains.ui.entry must be a .js file under ui/');
  else if (!existsSync(join(dir, spec.entry))) errors.push(`contains.ui.entry: ${spec.entry} is missing`);
  else if (!Array.isArray(permissions) || permissions.some((p) => !OS_PLUGIN_PERMISSIONS.includes(p as OsPluginPermission))) errors.push(`contains.ui.permissions can only list ${OS_PLUGIN_PERMISSIONS.join(', ')}`);
  else return { entry: spec.entry, permissions: permissions as OsPluginPermission[] };
  return null;
}

const insideKit = (path: string) => !!path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..');
const oneOf = (allowed: readonly unknown[], value: unknown) => allowed.includes(value);

// One row of the template index; the engine renders these paths into a project, so none may leave the kit folder.
function kitRowProblem(row: unknown, i: number, kitDir: string): string | null {
  if (!isObj(row) || typeof row.path !== 'string' || row.owner === undefined) return `row ${i + 1} needs a path and an owner`;
  const path = row.path;
  const checks: [boolean, string][] = [
    [insideKit(path), `${path} must be a relative path inside ${KIT_DIR}/`],
    [row.owner === 'kit' || row.owner === 'seed', `${path} has owner ${String(row.owner)}; use kit or seed`],
    [row.when === undefined || oneOf(KIT_WHEN, row.when), `${path} has when ${String(row.when)}; use ${KIT_WHEN.join(', ')}`],
    [row.stacks === undefined || (Array.isArray(row.stacks) && row.stacks.every((x) => oneOf(KIT_STACKS, x))), `${path} has stacks outside ${KIT_STACKS.join(', ')}`],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) return failed[1];
  return existsSync(join(kitDir, path)) ? null : `${path} is missing`;
}

function readKit(contains: Obj, dir: string, errors: string[]): string | null {
  if (contains.kit === undefined) return null;
  const index = join(dir, KIT_DIR, KIT_INDEX);
  if (contains.kit !== KIT_DIR) errors.push(`contains.kit must be "${KIT_DIR}"`);
  else if (!existsSync(index)) errors.push(`contains.kit: ${KIT_DIR}/${KIT_INDEX} is missing`);
  else {
    const rows = safely(() => JSON.parse(readFileSync(index, 'utf8')) as unknown, null);
    if (!Array.isArray(rows)) errors.push(`${KIT_DIR}/${KIT_INDEX} must be a list of rows`);
    else errors.push(...rows.flatMap((row, i) => kitRowProblem(row, i, join(dir, KIT_DIR)) ?? []).map((e) => `${KIT_DIR}/${KIT_INDEX}: ${e}`));
    return KIT_DIR;
  }
  return null;
}

type Parts = Pick<Manifest, 'skills' | 'hooks' | 'mcp' | 'ui' | 'kit'>;

function readContains(value: unknown, dir: string, errors: string[]): Parts | null {
  if (!isObj(value)) {
    errors.push('contains is required');
    return null;
  }
  for (const key of Object.keys(value)) if (!(OS_PLUGIN_COMPONENTS as readonly string[]).includes(key)) errors.push(`contains.${key} is not a known component`);
  const parts: Parts = { skills: readSkills(value, dir, errors), hooks: readHooks(value, dir, errors), mcp: readMcp(value, dir, errors), ui: readUi(value, dir, errors), kit: readKit(value, dir, errors) };
  if (parts.skills.length + parts.hooks.length + Object.keys(parts.mcp).length === 0 && !parts.ui && !parts.kit && !errors.some((e) => /skill|hook|server|contains/.test(e))) errors.push('contains lists nothing');
  return parts;
}

/** Every problem at once, so one pass over the manifest fixes them all. The folder is read, nothing in it is run. */
export function validateManifest(folder: string, dir: string): { manifest: Manifest | null; errors: string[]; raw: Obj } {
  const errors: string[] = [];
  const file = join(dir, MANIFEST);
  const parsed = safely(() => JSON.parse(readFileSync(file, 'utf8')) as unknown, undefined);
  if (!isObj(parsed)) return { manifest: null, errors: [existsSync(file) ? `${MANIFEST} is not a JSON object` : `no ${MANIFEST}`], raw: {} };
  const raw = parsed;
  checkIdentity(raw, folder, dir, errors);
  checkLooks(raw, errors);
  const dependencies = readDependencies(raw.dependencies, folder, dir, errors);
  const parts = readContains(raw.contains, dir, errors);
  if (errors.length || !parts) return { manifest: null, errors, raw };
  return { manifest: { id: folder, name: text(raw.name)!, description: text(raw.description)!, descriptionRu: text(raw.descriptionRu), features: texts(raw.features), featuresRu: texts(raw.featuresRu), icon: text(raw.icon), version: raw.version as string, author: text(raw.author)!, dependencies, ...parts }, errors, raw };
}
