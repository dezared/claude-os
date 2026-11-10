// The file tree and code view of a work tab. Everything is a path relative to the tab's cwd, and stays inside it.
// Read-only unless an enabled Claude OS plugin holds the permission to write or to open the file manager.
import { closeSync, createReadStream, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { FileEntry, OsPluginPermission, ProjectFile } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { gitFiles, SKIP_DIRS } from '../chat/files.ts';
import { kanbanDir } from './kanban.ts';
import { plannerDir } from './planner.ts';
import { httpError, safely, sha256 } from '../memory/util.ts';
import { launch } from './actions.ts';
import { validateRepoPath } from './git.ts';
import { platformKind, revealArgv } from './platform.ts';

export const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE = 8192;

// The lexical check catches `..` and absolute paths; realpath catches a symlink that leads out of the project.
function resolveInside(cwd: string, rel: unknown): string {
  const clean = validateRepoPath(rel);
  let real: string;
  try {
    real = realpathSync(join(cwd, clean));
  } catch {
    throw httpError(404, 'no such file');
  }
  const root = realpathSync(cwd);
  if (real !== root && !real.startsWith(root + sep)) throw httpError(403, 'outside the project');
  return real;
}

function entry(cwd: string, rel: string, dir: boolean): FileEntry | null {
  const stat = safely(() => lstatSync(join(cwd, rel)), null);
  if (!stat) return null; // tracked by git but deleted
  return { name: rel.slice(rel.lastIndexOf('/') + 1), path: rel, dir, size: dir ? null : stat.size };
}

// One level at a time: the tree is opened by hand, and a project can be huge. Git decides what is noise where it can.
export async function listDir(cwd: string, rel?: string): Promise<FileEntry[]> {
  const prefix = rel ? `${validateRepoPath(rel).split(sep).join('/')}/` : '';
  if (rel) resolveInside(cwd, rel);
  const tracked = await gitFiles(cwd);
  const names = new Map<string, boolean>();
  if (tracked) {
    for (const f of tracked) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
    }
  } else {
    for (const e of safely(() => readdirSync(join(cwd, prefix), { withFileTypes: true }), [])) {
      if (e.isDirectory() ? !SKIP_DIRS.has(e.name) : e.isFile()) names.set(e.name, e.isDirectory());
    }
  }
  const out = [...names].flatMap(([name, dir]) => entry(cwd, prefix + name, dir) ?? []);
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export function readProjectFile(cwd: string, rel: unknown): ProjectFile {
  const path = validateRepoPath(rel);
  const real = resolveInside(cwd, path);
  const stat = statSync(real);
  if (!stat.isFile()) throw httpError(400, 'not a file');
  const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
  const fd = openSync(real, 'r');
  let read: number;
  try {
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const bytes = buffer.subarray(0, read);
  if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { path, size: stat.size, kind: 'binary', text: null, truncated: false, sha: null };
  const truncated = stat.size > read;
  // A cut in the middle of a line could also be a cut in the middle of a character.
  const shown = truncated ? bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1 || read) : bytes;
  const text = shown.toString('utf8');
  // Only what would be written back byte for byte can be edited: not part of a file, not another encoding.
  const sha = !truncated && Buffer.from(text, 'utf8').equals(bytes) ? sha256(text) : null;
  return { path, size: stat.size, kind: 'text', text, truncated, sha };
}

/** Replaces a file's text if it is still the version the editor started from. Never creates a file. */
export function writeProjectFile(cwd: string, rel: unknown, text: unknown, sha: unknown): ProjectFile {
  if (typeof text !== 'string') throw httpError(400, 'text is required');
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw httpError(413, 'file too large');
  const current = readProjectFile(cwd, rel);
  if (current.sha === null) throw httpError(422, 'this file cannot be edited here');
  if (sha !== current.sha) throw httpError(409, 'the file changed on disk');
  writeFileSync(resolveInside(cwd, rel), text);
  return readProjectFile(cwd, rel);
}

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

// By the bytes, not the name: a secret renamed to .png stays unreadable here. No SVG: it is a document that can run scripts.
export function imageType(head: Buffer): string | null {
  const ascii = (from: number, to: number) => head.toString('latin1', from, to);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && ascii(8, 12).startsWith('avi')) return 'image/avif';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  return null;
}

export function readProjectImage(cwd: string, rel: unknown): { type: string; bytes: Buffer } {
  const real = resolveInside(cwd, rel);
  const stat = statSync(real);
  if (!stat.isFile()) throw httpError(400, 'not a file');
  if (stat.size > MAX_IMAGE_BYTES) throw httpError(413, 'image too large');
  const bytes = readFileSync(real);
  const type = imageType(bytes.subarray(0, 16));
  if (!type) throw httpError(415, 'not an image');
  return { type, bytes };
}

/** The same rule for sound and video: the bytes decide, so a player can only ever be handed what it plays. */
export function mediaType(head: Buffer): string | null {
  const ascii = (from: number, to: number) => head.toString('latin1', from, to);
  const image = imageType(head);
  if (image) return image;
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return 'image/x-icon';
  if (ascii(4, 8) === 'ftyp') return ascii(8, 11) === 'M4A' || ascii(8, 11) === 'M4B' ? 'audio/mp4' : ascii(8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'audio/aac';
  return null;
}

/** `bytes=a-b` as a player asks for it, to seek. Null: the whole file. */
export function parseRange(header: unknown, size: number): { start: number; end: number } | 'bad' | null {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return 'bad';
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end ? 'bad' : { start, end };
}

/**
 * A chat speaks in the paths Claude used: absolute ones too, and not only in this tab's folder. Those resolve against the
 * tab's cwd or a known project's root, and from there go through the same checks as a relative path.
 * A relative path missing in the cwd is tried against the tab's project root: Claude may have meant the project, not a subfolder.
 */
export function locate(cwd: string, roots: string[], path: unknown, projectRoot: string | null = null): { cwd: string; rel: unknown } {
  if (typeof path !== 'string') return { cwd, rel: path };
  const full = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(full)) {
    if (projectRoot && projectRoot !== cwd && !existsSync(join(cwd, full)) && existsSync(join(projectRoot, full))) return { cwd: projectRoot, rel: full };
    return { cwd, rel: full };
  }
  for (const root of [cwd, ...roots]) {
    const rel = relative(root, full);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { cwd: root, rel };
  }
  throw httpError(403, 'outside the project');
}

/** What a session reads besides projects: attachments, planner notes, task cards, scratch files. Read only: never written or revealed through a tab. */
export const extraRoots = (ctx: Pick<Ctx, 'paths'>) => [join(ctx.paths.data, 'uploads'), plannerDir(ctx), kanbanDir(ctx), '/tmp'];

export function registerProjectFiles(ctx: Ctx, tabCwd: (id: string) => string, allows: (permission: OsPluginPermission) => boolean, tabProject: (id: string) => string | null = () => null): void {
  type Req = { Params: { id: string }; Querystring: { path?: string } };
  const extra = extraRoots(ctx);
  const place = (id: string, path: unknown, read = false) => {
    const projects = safely(() => ctx.journal.listProjects(true), []);
    const key = tabProject(id);
    const projectRoot = (key && projects.find((p) => p.key === key)?.root) || null;
    return locate(tabCwd(id), [...projects.map((p) => p.root), ...(read ? extra : [])], path, projectRoot);
  };
  const found = (req: { params: { id: string }; query: { path?: string } }) => place(req.params.id, req.query.path, true);
  const need = (permission: OsPluginPermission) => {
    if (!allows(permission)) throw httpError(403, `no enabled plugin holds ${permission}`);
  };
  ctx.app.put<{ Params: { id: string }; Body: { path?: unknown; text?: unknown; sha?: unknown } | null }>('/api/tabs/:id/file', async (req) => {
    need('files.write');
    const { cwd, rel } = place(req.params.id, req.body?.path);
    const saved = writeProjectFile(cwd, rel, req.body?.text, req.body?.sha);
    ctx.audit('file.write', resolveInside(cwd, rel), null);
    return saved;
  });
  ctx.app.post<{ Params: { id: string }; Body: { path?: unknown } | null }>('/api/tabs/:id/reveal', async (req) => {
    need('files.reveal');
    const { cwd, rel } = place(req.params.id, req.body?.path);
    const real = resolveInside(cwd, rel);
    const { bin, args } = revealArgv(platformKind(), real, statSync(real).isDirectory());
    await launch(bin, args);
    return { ok: true };
  });
  ctx.app.get<Req>('/api/tabs/:id/media', async (req, reply) => {
    need('files.media');
    const { cwd, rel } = found(req);
    const real = resolveInside(cwd, rel);
    const stat = statSync(real);
    if (!stat.isFile()) throw httpError(400, 'not a file');
    const { size } = stat;
    const head = Buffer.alloc(16);
    const fd = openSync(real, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const type = mediaType(head);
    if (!type) throw httpError(415, 'not an image, sound or video');
    reply.type(type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=30').header('accept-ranges', 'bytes');
    const range = parseRange(req.headers.range, size);
    if (range === 'bad') return reply.code(416).header('content-range', `bytes */${size}`).send();
    if (!range) return reply.header('content-length', size).send(createReadStream(real));
    return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1).send(createReadStream(real, range));
  });
  ctx.app.get<Req>('/api/tabs/:id/tree', async (req) => listDir(tabCwd(req.params.id), req.query.path || undefined));
  ctx.app.get<Req>('/api/tabs/:id/file', async (req) => {
    const { cwd, rel } = found(req);
    return readProjectFile(cwd, rel);
  });
  ctx.app.get<Req>('/api/tabs/:id/image', async (req, reply) => {
    const { cwd, rel } = found(req);
    const { type, bytes } = readProjectImage(cwd, rel);
    return reply.type(type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=30').send(bytes);
  });
}
