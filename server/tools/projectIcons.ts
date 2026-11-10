// Project icons: a name from a free library per project in config/project-icons/icons.json, custom SVGs beside it.
// Nothing is trusted: an allowlist rebuilds each file or rejects it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'chokidar';
import { LIBRARY_ICON_INK, type IconLibrary, type ProjectIcons } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';
import { readJson } from './shared.ts';

export const MAX_ICON_BYTES = 16 * 1024;
const OFFER_MARK = '.offer-dismissed';
const CHOICES = 'icons.json';

const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'd', 'fill', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-opacity', 'stroke-miterlimit', 'stroke-dasharray', 'opacity', 'transform', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points',
]);
const SAFE_VALUE = /^[\w\s#.,%()+\-/:]*$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

export type SanitizeResult = { ok: true; svg: string } | { ok: false; reason: string };

/** Nothing of the source reaches the output except tags and attributes this function has checked and rebuilt. */
export function sanitizeSvg(source: string): SanitizeResult {
  const bad = (reason: string): SanitizeResult => ({ ok: false, reason });
  if (Buffer.byteLength(source) > MAX_ICON_BYTES) return bad('too large');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(source)) return bad('doctype, entity or cdata');
  const text = source
    .replace(/^﻿/, '')
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(title|desc)(\s[^>]*)?>[^<]*<\/\1\s*>/gi, '')
    .trim();
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>/g;
  const stack: string[] = [];
  let out = '';
  let last = 0;
  let sawRoot = false;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (text.slice(last, m.index).trim()) return bad('text content');
    last = m.index + m[0].length;
    const [, close, name, attrs, selfClose] = m;
    if (!ELEMENTS.has(name)) return bad(`element ${name}`);
    if (close) {
      if (stack.pop() !== name) return bad('unbalanced tags');
      out += `</${name}>`;
      continue;
    }
    if (!sawRoot && name !== 'svg') return bad('root is not svg');
    if (sawRoot && stack.length === 0) return bad('more than one root');
    const parts: string[] = [];
    for (const a of attrs.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = a[2] ?? a[3] ?? '';
      if (!ATTRIBUTES.has(a[1])) return bad(`attribute ${a[1]}`);
      if (!SAFE_VALUE.test(value) || /url\s*\(|script|data:/i.test(value.replace(SVG_NS, ''))) return bad(`value of ${a[1]}`);
      if (a[1] === 'xmlns' && value !== SVG_NS) return bad('namespace');
      parts.push(` ${a[1]}="${value}"`);
    }
    if (!sawRoot) {
      if (!parts.some((p) => p.startsWith(' viewBox='))) return bad('no viewBox');
      if (!parts.some((p) => p.startsWith(' xmlns='))) parts.unshift(` xmlns="${SVG_NS}"`);
    }
    sawRoot = true;
    if (selfClose) {
      if (stack.length === 0) return bad('empty svg');
      out += `<${name}${parts.join('')}/>`;
    } else {
      stack.push(name);
      out += `<${name}${parts.join('')}>`;
    }
  }
  if (text.slice(last).trim()) return bad('text content');
  if (!sawRoot || stack.length > 0) return bad('unbalanced tags');
  return { ok: true, svg: out };
}

// ---------- The free libraries: a name is a file of lucide, or `si:<slug>` for a simple-icons logo ----------

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const LUCIDE_DIR = dirname(fileURLToPath(import.meta.resolve('lucide-react/icons/map')));
const SIMPLE_DIR = dirname(fileURLToPath(import.meta.resolve('simple-icons/icons/gitlab.svg')));
const PAGE = 96;
const STARTER = ['folder', 'code', 'terminal', 'server', 'database', 'globe', 'cloud', 'network', 'bot', 'brain', 'cpu', 'rocket', 'map', 'compass', 'house', 'store', 'shopping-cart', 'coins', 'wallet', 'chart-line', 'users', 'user', 'messages-square', 'mail', 'bell', 'calendar', 'book-open', 'notebook-pen', 'file-text', 'image', 'video', 'music', 'gamepad-2', 'dices', 'spade', 'puzzle', 'wrench', 'shield', 'lock', 'key-round', 'search', 'zap', 'flame', 'leaf', 'heart', 'star', 'panels-top-left', 'git-merge', 'si:github', 'si:gitlab', 'si:docker', 'si:telegram', 'si:discord', 'si:react', 'si:nodedotjs', 'si:php', 'si:python', 'si:symfony', 'si:postgresql', 'si:redis'];

const rendered = new Map<string, string | null>();
const fileNames = (dir: string, ext: string) => readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => n.slice(0, -ext.length));
let allNames: string[] | null = null;

export function libraryHas(name: string): boolean {
  const simple = name.startsWith('si:');
  const slug = simple ? name.slice(3) : name;
  return SLUG.test(slug) && existsSync(simple ? join(SIMPLE_DIR, `${slug}.svg`) : join(LUCIDE_DIR, `${slug}.mjs`));
}

/** The library's own shapes, put through the same sanitizer as any other icon. Null for a name the library does not have. */
export async function renderLibraryIcon(name: string): Promise<string | null> {
  const known = rendered.get(name);
  if (known !== undefined) return known;
  const simple = name.startsWith('si:');
  const slug = simple ? name.slice(3) : name;
  if (!SLUG.test(slug)) return null;
  let source: string | null = null;
  if (simple) {
    const d = /\bd="([^"]+)"/.exec(safely(() => readFileSync(join(SIMPLE_DIR, `${slug}.svg`), 'utf8'), ''))?.[1];
    if (d) source = `<svg viewBox="0 0 24 24" xmlns="${SVG_NS}" fill="${LIBRARY_ICON_INK}"><path d="${d}"/></svg>`;
  } else {
    // An old name is a file that only re-exports the current one, without the shapes.
    const alias = /from '\.\/([a-z0-9-]+)\.mjs'/.exec(safely(() => readFileSync(join(LUCIDE_DIR, `${slug}.mjs`), 'utf8'), ''))?.[1];
    const icon = await import(`lucide-react/icons/${alias && alias !== 'createLucideIcon' ? alias : slug}`).catch(() => null) as { __iconData?: { node: [string, Record<string, string>][] } } | null;
    const body = icon?.__iconData?.node.map(([tag, { key: _key, ...attrs }]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');
    if (body) source = `<svg viewBox="0 0 24 24" xmlns="${SVG_NS}" fill="none" stroke="${LIBRARY_ICON_INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }
  const result = source ? sanitizeSvg(source) : null;
  const svg = result?.ok ? result.svg : null;
  rendered.set(name, svg);
  return svg;
}

export async function searchLibrary(raw: unknown): Promise<IconLibrary> {
  const q = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  allNames ??= [...fileNames(LUCIDE_DIR, '.mjs'), ...fileNames(SIMPLE_DIR, '.svg').map((n) => `si:${n}`)];
  const bare = (n: string) => n.replace(/^si:/, '');
  const hits = q ? allNames.filter((n) => n.includes(q)).sort((a, b) => Number(!bare(a).startsWith(q)) - Number(!bare(b).startsWith(q)) || a.length - b.length || a.localeCompare(b)) : STARTER;
  const items = await Promise.all(hits.slice(0, PAGE).map(async (name) => ({ name, svg: await renderLibraryIcon(name) })));
  return { total: hits.length, items: items.flatMap((i) => (i.svg ? [{ name: i.name, svg: i.svg }] : [])) };
}

export function createProjectIcons(ctx: Ctx) {
  const dir = join(ctx.paths.config, 'project-icons');
  const choicesFile = join(dir, CHOICES);
  mkdirSync(dir, { recursive: true });

  const readChoices = (): Record<string, unknown> => {
    const raw = readJson<unknown>(choicesFile);
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  };

  async function view(): Promise<ProjectIcons> {
    const icons: ProjectIcons['icons'] = {};
    const rejected: ProjectIcons['rejected'] = [];
    for (const name of safely(() => readdirSync(dir), [])) {
      if (!name.endsWith('.svg') || name.startsWith('.')) continue;
      const key = name.slice(0, -4);
      const path = join(dir, name);
      // A symlink could point anywhere: only a plain file of a sane size is opened at all.
      const st = safely(() => lstatSync(path), null);
      if (!st?.isFile()) { rejected.push({ key, reason: 'not a plain file' }); continue; }
      if (st.size > MAX_ICON_BYTES) { rejected.push({ key, reason: 'too large' }); continue; }
      const result = sanitizeSvg(safely(() => readFileSync(path, 'utf8'), ''));
      if (result.ok) icons[key] = result.svg;
      else rejected.push({ key, reason: result.reason });
    }
    const chosen: ProjectIcons['chosen'] = {};
    for (const [key, name] of Object.entries(readChoices())) {
      const svg = typeof name === 'string' ? await renderLibraryIcon(name) : null;
      if (svg) {
        icons[key] = svg;
        chosen[key] = name as string;
      } else rejected.push({ key, reason: `unknown icon ${String(name)}` });
    }
    return { dir, icons, chosen, rejected, offerDismissed: safely(() => (lstatSync(join(dir, OFFER_MARK)), true), false) };
  }

  function dismissOffer(): Promise<ProjectIcons> {
    writeFileSync(join(dir, OFFER_MARK), '');
    return view();
  }

  async function choose(key: string, icon: unknown): Promise<ProjectIcons> {
    if (!ctx.journal.listProjects(true).some((p) => p.key === key)) throw httpError(404, 'unknown project');
    if (icon !== null && (typeof icon !== 'string' || !(await renderLibraryIcon(icon)))) throw httpError(400, 'the library has no such icon');
    const { [key]: before, ...rest } = readChoices();
    writeFileSync(choicesFile, JSON.stringify(icon === null ? rest : { ...rest, [key]: icon }, null, 2) + '\n');
    ctx.audit('project.icon', key, `${String(before ?? '')} -> ${String(icon ?? '')}`);
    ctx.invalidate('projects');
    return view();
  }

  const watcher = watch(dir, { ignoreInitial: true, depth: 0 }).on('all', (_event, path) => {
    const name = relative(dir, path);
    if (name.endsWith('.svg') || name === CHOICES) ctx.invalidate('projects');
  });
  ctx.app.addHook('onClose', async () => { await watcher.close(); });

  ctx.app.get('/api/project-icons', async () => view());
  ctx.app.post('/api/project-icons/dismiss-offer', async () => dismissOffer());
  ctx.app.get<{ Querystring: { q?: string } }>('/api/project-icons/library', async (req) => searchLibrary(req.query.q));
  ctx.app.put<{ Params: { key: string }; Body: { icon?: unknown } | null }>('/api/project-icons/:key', async (req) => choose(req.params.key, req.body?.icon ?? null));
}
