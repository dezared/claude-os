// Planner notes: free text saved at once to inbox/, then filed by Claude under general/<topic>/. Notes filed before folders stay under projects/<key>/.
// A folder of its own under data/: not memory notes, nothing here touches the vault.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOLDER_COLORS, type PlannerFolder, type PlannerJob, type PlannerNote } from '../../shared/contract.ts';
import { parseItem } from '../../shared/plannerItems.ts';
import type { Ctx } from '../context.ts';
import { httpError, parseFrontmatter, safely } from '../memory/util.ts';
import { servicePrompt } from './microtasks.ts';
import { imageType, MAX_IMAGE_BYTES } from './projectFiles.ts';

const MAX_TEXT = 100_000;
const TITLE_LENGTH = 80;
const SLUG_LENGTH = 40;
const INBOX = 'inbox';
const ID = /^[\p{L}\p{N}-]{1,120}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Under data/planner: session.ts gives every session Read there without a prompt, and writing stays denied.
const IMAGES = 'images';
const IMAGE_NAME = /^[\w-]+\.(png|jpg|gif|webp)$/;
// What a session's Read can show: other image types would save fine and reach Claude as nothing.
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// Folders are the owner's own grouping: a file beside the notes, keyed by note id, so filing and renames never touch them.
const FOLDERS = 'folders.json';
const FOLDER_NAME_LENGTH = 60;
const DECOMPOSE_ROUNDS = 3; // a brainstorm: questions, a follow-up, a last check

export const plannerDir = (ctx: Pick<Ctx, 'paths'>) => join(ctx.paths.data, 'planner');

// By code points: half of a surrogate pair in a title shows as garbage, and in an id makes the note unreachable.
const clip = (text: string, length: number) => [...text].slice(0, length).join('');
const slug = (text: string) => clip(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'), SLUG_LENGTH).replace(/^-+|-+$/g, '');

function noteFiles(dir: string): string[] {
  return safely(() => readdirSync(dir, { withFileTypes: true }), []).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return noteFiles(join(dir, e.name));
    return e.isFile() && e.name.endsWith('.md') ? [join(dir, e.name)] : [];
  });
}

function readNote(dir: string, path: string): PlannerNote {
  const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  return {
    id: path.slice(path.lastIndexOf('/') + 1, -3),
    path,
    title: data.title ?? '',
    text: body,
    created: data.created ?? '',
    filed: !path.startsWith(join(dir, INBOX) + '/'),
    topic: data.topic || null,
    date: data.date || null,
    version: createHash('sha256').update(body).digest('hex').slice(0, 16),
  };
}

function writeNote(path: string, note: Pick<PlannerNote, 'title' | 'text' | 'created' | 'topic' | 'date'>): void {
  const meta = { title: note.title, created: note.created, topic: note.topic, date: note.date };
  const head = Object.entries(meta).flatMap(([k, v]) => (v === null ? [] : [`${k}: ${JSON.stringify(v)}`]));
  writeFileSync(path, `---\n${head.join('\n')}\n---\n${note.text}`);
}

// Symlinks are not listed by noteFiles, and an id has no separators: a note is always a file of this folder.
export function find(dir: string, id: unknown): PlannerNote {
  if (typeof id !== 'string' || !ID.test(id)) throw httpError(400, 'bad note id');
  const path = noteFiles(dir).find((p) => p.endsWith(`/${id}.md`));
  if (!path) throw httpError(404, `no planner note ${id}`);
  return readNote(dir, path);
}

export function listNotes(dir: string): PlannerNote[] {
  return noteFiles(dir).map((p) => readNote(dir, p)).sort((a, b) => b.created.localeCompare(a.created));
}

function cleanText(text: unknown): string {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw httpError(400, 'a note is text, up to 100 000 characters');
  const clean = text.split('\n').filter((line) => parseItem(line)?.text !== '').join('\n').trim();
  if (!clean) throw httpError(400, 'a note is text, up to 100 000 characters');
  return clean;
}

function firstLine(dir: string, text: string): string {
  const images = join(dir, IMAGES) + '/';
  return text.split('\n').map((line) => parseItem(line)?.text ?? line.trim()).find((line) => line && !line.startsWith(images)) ?? 'image';
}

export function addNote(dir: string, text: unknown, now = new Date()): PlannerNote {
  const clean = cleanText(text);
  const created = now.toISOString();
  const first = firstLine(dir, clean);
  const id = `${created.slice(0, 10)}-${slug(first) || 'note'}-${randomBytes(2).toString('hex')}`;
  const inbox = join(dir, INBOX);
  mkdirSync(inbox, { recursive: true });
  const path = join(inbox, `${id}.md`);
  writeNote(path, { title: clip(first, TITLE_LENGTH), text: clean, created, topic: null, date: null });
  return readNote(dir, path);
}

export interface FileRequest {
  folder?: string | null; // the name of an existing folder; none: the note stays in the one it is in
  topic?: string | null;
  date?: string | null; // YYYY-MM-DD: the day the note is about
  title?: string | null;
}

// Every part of the path goes through slug(): whatever Claude passes stays inside the folder.
export function fileNote(dir: string, id: unknown, req: FileRequest): PlannerNote {
  const note = find(dir, id);
  if (req.date && !DATE.test(req.date)) throw httpError(400, 'date must be YYYY-MM-DD');
  // Before the file moves: a folder that does not exist leaves the note where it was.
  const store = readFolders(dir);
  const name = req.folder?.trim().toLowerCase();
  const folder = name ? store.folders.find((f) => f.name.toLowerCase() === name) : undefined;
  if (name && !folder) throw httpError(404, `no folder "${req.folder}". There are: ${store.folders.map((f) => f.name).join(', ') || 'none'}`);
  const topic = req.topic || null;
  const date = req.date || null;
  const target = join(dir, 'general', slug(topic ?? '') || date || 'misc');
  mkdirSync(target, { recursive: true });
  const path = join(target, `${note.id}.md`);
  writeNote(path, { ...note, title: clip(req.title ?? '', TITLE_LENGTH) || note.title, topic, date });
  if (path !== note.path) rmSync(note.path);
  if (folder) {
    store.notes[note.id] = folder.id;
    writeFolders(dir, store);
  }
  return readNote(dir, path);
}

// The new text goes where the note is now: filing moves the file and does not change the version.
export function saveText(dir: string, id: unknown, text: unknown, version: unknown): PlannerNote {
  const note = find(dir, id);
  if (version !== note.version) throw httpError(409, 'the note has changed: reload it');
  const clean = cleanText(text);
  // A title Claude gave stays; one that only repeated the first line follows it.
  const title = note.title === clip(firstLine(dir, note.text), TITLE_LENGTH) ? clip(firstLine(dir, clean), TITLE_LENGTH) : note.title;
  writeNote(note.path, { ...note, title, text: clean });
  return readNote(dir, note.path);
}

// The name on the row. The id and so the file keep theirs: a mention already sent still points at it.
export function renameNote(dir: string, id: unknown, title: unknown): PlannerNote {
  const note = find(dir, id);
  const clean = typeof title === 'string' ? clip(title.replace(/\s+/g, ' ').trim(), TITLE_LENGTH) : '';
  if (!clean) throw httpError(400, 'a title is text');
  writeNote(note.path, { ...note, title: clean });
  return readNote(dir, note.path);
}

// Deleting moves the file aside: the text was the owner's, and nothing else keeps a copy.
export function removeNote(dir: string, id: unknown): void {
  const note = find(dir, id);
  const trash = join(dir, '.trash');
  mkdirSync(trash, { recursive: true });
  renameSync(note.path, join(trash, `${note.id}.md`));
  const store = readFolders(dir);
  if (store.notes[note.id]) {
    delete store.notes[note.id];
    writeFolders(dir, store);
  }
}

interface FolderStore {
  folders: PlannerFolder[];
  notes: Record<string, string>; // note id -> folder id
}

// Any colour the owner picks; a strict #rrggbb, so it can only ever be a colour in a style attribute.
const isColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

function readFolders(dir: string): FolderStore {
  const raw = safely(() => JSON.parse(readFileSync(join(dir, FOLDERS), 'utf8')) as Partial<FolderStore>, null);
  return {
    // A folder from before colours gets one by its place in the list.
    folders: Array.isArray(raw?.folders) ? raw.folders.filter((f) => typeof f?.id === 'string' && typeof f.name === 'string').map((f, i) => ({ ...f, color: isColor(f.color) ? f.color.toLowerCase() : FOLDER_COLORS[i % FOLDER_COLORS.length] })) : [],
    notes: raw?.notes && typeof raw.notes === 'object' ? raw.notes : {},
  };
}

function writeFolders(dir: string, store: FolderStore): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FOLDERS);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1));
  renameSync(tmp, file);
}

function folderName(store: FolderStore, name: unknown, self?: string): string {
  const clean = typeof name === 'string' ? clip(name.replace(/\s+/g, ' ').trim(), FOLDER_NAME_LENGTH) : '';
  if (!clean) throw httpError(400, 'a folder name is text');
  if (store.folders.some((f) => f.id !== self && f.name.toLowerCase() === clean.toLowerCase())) throw httpError(409, 'there is already a folder with this name');
  return clean;
}

const folderIn = (store: FolderStore, id: unknown): PlannerFolder => {
  const folder = store.folders.find((f) => f.id === id);
  if (!folder) throw httpError(404, 'no such folder');
  return folder;
};

export const listFolders = (dir: string): PlannerFolder[] => readFolders(dir).folders;

/** Which folder a note is in, for every note in one. A folder that is gone counts as none. */
export function folderOfNotes(dir: string): Map<string, string> {
  const store = readFolders(dir);
  return new Map(Object.entries(store.notes).filter(([, folder]) => store.folders.some((f) => f.id === folder)));
}

export function addFolder(dir: string, name: unknown): PlannerFolder {
  const store = readFolders(dir);
  const folder = newFolder(store, folderName(store, name));
  writeFolders(dir, store);
  return folder;
}

// The colour fewest folders have: a new folder stands out from the ones beside it.
function newFolder(store: FolderStore, name: string): PlannerFolder {
  const uses = (color: string) => store.folders.filter((f) => f.color === color).length;
  const color = FOLDER_COLORS.reduce<string>((best, c) => (uses(c) < uses(best) ? c : best), FOLDER_COLORS[0]);
  const folder = { id: randomBytes(4).toString('hex'), name, color };
  store.folders.push(folder);
  return folder;
}

export function setFolderColor(dir: string, id: unknown, color: unknown): PlannerFolder {
  if (!isColor(color)) throw httpError(400, 'not a folder colour');
  const store = readFolders(dir);
  const folder = folderIn(store, id);
  folder.color = color.toLowerCase();
  writeFolders(dir, store);
  return folder;
}

/** `ids`: every folder's id, each once, in the new order. */
export function setFolderOrder(dir: string, ids: unknown): PlannerFolder[] {
  const store = readFolders(dir);
  const byId = new Map(store.folders.map((f) => [f.id, f]));
  if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) throw httpError(400, 'ids must be every folder id, each once');
  store.folders = ids.map((id) => byId.get(id)!);
  writeFolders(dir, store);
  return store.folders;
}

/**
 * Notes used to belong to a project. Now each goes to the folder named after it, unless it is already in a folder, and the
 * field leaves the file: the folder is written first, so a run cut short only repeats, and a folder deleted later does not return.
 * The files stay where they are: a mention already sent still points at them.
 */
export function moveProjectsToFolders(dir: string, nameOf: (key: string) => string): void {
  const linked = noteFiles(dir).flatMap((path) => {
    const key = parseFrontmatter(readFileSync(path, 'utf8')).data.project;
    return key ? [{ path, key }] : [];
  });
  if (linked.length === 0) return;
  const store = readFolders(dir);
  for (const { path, key } of linked) {
    const id = path.slice(path.lastIndexOf('/') + 1, -3);
    if (store.folders.some((f) => f.id === store.notes[id])) continue;
    const name = clip(nameOf(key).replace(/\s+/g, ' ').trim(), FOLDER_NAME_LENGTH) || key;
    const folder = store.folders.find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? newFolder(store, name);
    store.notes[id] = folder.id;
  }
  writeFolders(dir, store);
  for (const { path } of linked) writeNote(path, readNote(dir, path));
}

export function renameFolder(dir: string, id: unknown, name: unknown): PlannerFolder {
  const store = readFolders(dir);
  const folder = folderIn(store, id);
  folder.name = folderName(store, name, folder.id);
  writeFolders(dir, store);
  return folder;
}

// The notes stay where they are and simply belong to no folder.
export function removeFolder(dir: string, id: unknown): void {
  const store = readFolders(dir);
  const folder = folderIn(store, id);
  store.folders = store.folders.filter((f) => f !== folder);
  store.notes = Object.fromEntries(Object.entries(store.notes).filter(([, f]) => f !== folder.id));
  writeFolders(dir, store);
}

/** `folder`: an existing folder's id, or null to take the note out. */
export function moveToFolder(dir: string, id: unknown, folder: unknown): void {
  const note = find(dir, id);
  const store = readFolders(dir);
  if (folder === null) delete store.notes[note.id];
  else store.notes[note.id] = folderIn(store, folder).id;
  writeFolders(dir, store);
}

export function itemsOf(text: string): { item: number; done: boolean; text: string }[] {
  return text.split('\n').flatMap((line) => parseItem(line) ?? []).map((i, n) => ({ item: n + 1, done: i.done, text: i.text }));
}

// `item` is a number from 1 or the exact text. `expected` is what the caller saw: numbers shift when a session removes an item.
function changeItem(dir: string, id: unknown, item: unknown, expected: unknown, change: (i: { indent: string; text: string }) => string[]): PlannerNote {
  const note = find(dir, id);
  const lines = note.text.split('\n');
  const found = lines.flatMap((line, at) => {
    const parsed = parseItem(line);
    return parsed ? [{ ...parsed, at }] : [];
  });
  let target;
  if (typeof item === 'number' && Number.isInteger(item) && item > 0) target = found[item - 1];
  else if (typeof item === 'string' && item.trim()) {
    const same = found.filter((i) => i.text === item.trim());
    if (same.length > 1) throw httpError(409, `several items say "${item.trim()}": pass the number`);
    target = same[0];
  } else throw httpError(400, 'item is a number from 1 or the exact text');
  if (!target) throw httpError(404, `no item ${String(item)} in note ${note.id}`);
  if (expected !== undefined && expected !== target.text) throw httpError(409, 'the note has changed: reload it');
  lines.splice(target.at, 1, ...change(target));
  writeNote(note.path, { ...note, text: lines.join('\n') });
  return readNote(dir, note.path);
}

export function setItem(dir: string, id: unknown, item: unknown, done: unknown, expected?: unknown): PlannerNote {
  if (typeof done !== 'boolean') throw httpError(400, 'done is true or false');
  return changeItem(dir, id, item, expected, (i) => [`${i.indent}- [${done ? 'x' : ' '}] ${i.text}`]);
}

export function removeItem(dir: string, id: unknown, item: unknown, expected?: unknown): PlannerNote {
  return changeItem(dir, id, item, expected, () => []);
}

// The name comes from here and the type from the bytes: nothing the browser says about the file reaches the disk.
export function addImage(dir: string, base64: unknown, now = new Date()): { path: string } {
  if (typeof base64 !== 'string' || !base64) throw httpError(400, 'an image is base64 data');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'image too large');
  const ext = IMAGE_EXT[imageType(bytes.subarray(0, 16)) ?? ''];
  if (!ext) throw httpError(415, 'an image is PNG, JPEG, GIF or WebP');
  const folder = join(dir, IMAGES);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${now.toISOString().slice(0, 10)}-${randomBytes(8).toString('hex')}.${ext}`);
  writeFileSync(path, bytes);
  return { path };
}

export function readImage(dir: string, name: unknown): { type: string; bytes: Buffer } {
  if (typeof name !== 'string' || !IMAGE_NAME.test(name)) throw httpError(400, 'bad image name');
  const path = join(dir, IMAGES, name);
  if (!safely(() => lstatSync(path).isFile(), false)) throw httpError(404, 'no such image');
  const bytes = readFileSync(path);
  const type = imageType(bytes.subarray(0, 16));
  if (!type) throw httpError(415, 'not an image');
  return { type, bytes };
}

export function registerPlanner(ctx: Ctx): void {
  const dir = plannerDir(ctx);
  const { app } = ctx;
  // A note that cannot be read here fails where it is listed too: not a reason for the server not to start.
  safely(() => {
    const projects = ctx.journal?.listProjects(true) ?? [];
    moveProjectsToFolders(dir, (key) => projects.find((p) => p.key === key)?.name ?? key);
  }, undefined);
  // What the service session is doing for a note. Memory only: after a restart the note is simply where it was, ready to retry.
  const jobs = new Map<string, PlannerJob>();
  const withJob = (note: PlannerNote): PlannerNote => {
    const job = jobs.get(note.id);
    return job ? { ...note, job } : note;
  };
  const runJob = (id: string): PlannerNote => {
    const note = find(dir, id);
    const current = jobs.get(note.id);
    if (current && current.state !== 'failed') return withJob(note);
    if (!ctx.chat) throw httpError(503, 'no chat module');
    const vars = { id: note.id, text: note.text, version: note.version, today: new Date().toLocaleDateString('sv'), folders: listFolders(dir).map((f) => f.name).join(', ') || 'none' };
    const prompt = servicePrompt(ctx, 'planner-file', vars);
    const set = (job: PlannerJob | null) => {
      if (job) jobs.set(note.id, job);
      else jobs.delete(note.id);
      ctx.invalidate('planner');
    };
    set({ state: 'queued' });
    ctx.chat.runServiceJob(prompt, {
      start: () => set({ state: 'running' }),
      end: (error) => {
        const now = safely(() => find(dir, note.id), null);
        set(!now || (now.filed && !error) ? null : { state: 'failed', error: error ?? 'Claude finished without filing the note' });
      },
    });
    return withJob(note);
  };
  app.get('/api/planner', async () => {
    const inFolder = folderOfNotes(dir);
    return { dir, folders: listFolders(dir), notes: listNotes(dir).map((n) => ({ ...withJob(n), folder: inFolder.get(n.id) ?? null })) };
  });
  // `folder`: the one open in the panel. Checked first: a folder that is gone creates no note.
  app.post<{ Body: { text?: unknown; folder?: unknown } }>('/api/planner', async (req) => {
    const folder = req.body?.folder ?? null;
    if (folder !== null) folderIn(readFolders(dir), folder);
    const note = addNote(dir, req.body?.text);
    if (folder !== null) moveToFolder(dir, note.id, folder);
    ctx.invalidate('planner');
    return note;
  });
  app.get<{ Params: { id: string } }>('/api/planner/:id', async (req) => withJob(find(dir, req.params.id)));
  app.put<{ Params: { id: string }; Body: { text?: unknown; version?: unknown } }>('/api/planner/:id', async (req) => {
    const note = saveText(dir, req.params.id, req.body?.text, req.body?.version);
    ctx.audit('planner.edit', note.path);
    ctx.invalidate('planner');
    return withJob(note);
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown } }>('/api/planner/:id', async (req) => {
    const note = renameNote(dir, req.params.id, req.body?.title);
    ctx.invalidate('planner');
    return withJob(note);
  });
  app.post<{ Params: { id: string } }>('/api/planner/:id/file', async (req) => runJob(req.params.id));
  // Into a task of the service session, shown in a dialog: the questions and the answer stay in that one mechanism.
  app.post<{ Params: { id: string } }>('/api/planner/:id/decompose', async (req) => {
    const note = find(dir, req.params.id);
    if (!ctx.chat) throw httpError(503, 'no chat module');
    // A note has no project of its own: a folder named after one still says where the cards go.
    const folder = listFolders(dir).find((f) => f.id === folderOfNotes(dir).get(note.id))?.name.toLowerCase();
    const project = ctx.journal.listProjects(true).find((p) => p.name.toLowerCase() === folder)?.key ?? null;
    const prompt = servicePrompt(ctx, 'planner-decompose', { id: note.id, project: project ?? 'none', text: note.text });
    return ctx.chat.tasks.start({ title: note.title, prompt, project, modal: true, rounds: DECOMPOSE_ROUNDS, ...(project ? { link: project } : {}) });
  });
  app.put<{ Params: { id: string }; Body: { folder?: unknown } }>('/api/planner/:id/folder', async (req) => {
    moveToFolder(dir, req.params.id, req.body?.folder ?? null);
    ctx.invalidate('planner');
    return { ok: true };
  });
  app.post<{ Body: { name?: unknown } }>('/api/planner/folders', async (req) => {
    const folder = addFolder(dir, req.body?.name);
    ctx.invalidate('planner');
    return folder;
  });
  app.put<{ Body: { ids?: unknown } }>('/api/planner/folders/order', async (req) => {
    const folders = setFolderOrder(dir, req.body?.ids);
    ctx.invalidate('planner');
    return folders;
  });
  app.patch<{ Params: { id: string }; Body: { name?: unknown; color?: unknown } }>('/api/planner/folders/:id', async (req) => {
    const folder = req.body?.color !== undefined ? setFolderColor(dir, req.params.id, req.body.color) : renameFolder(dir, req.params.id, req.body?.name);
    ctx.invalidate('planner');
    return folder;
  });
  app.delete<{ Params: { id: string } }>('/api/planner/folders/:id', async (req) => {
    removeFolder(dir, req.params.id);
    ctx.audit('planner.folder.delete', req.params.id);
    ctx.invalidate('planner');
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/planner/:id', async (req) => {
    removeNote(dir, req.params.id);
    ctx.audit('planner.delete', req.params.id);
    ctx.invalidate('planner');
    return { ok: true };
  });
  app.post<{ Body: { base64?: unknown } }>('/api/planner/images', async (req) => addImage(dir, req.body?.base64));
  app.get<{ Params: { name: string } }>('/api/planner/images/:name', async (req, reply) => {
    const { type, bytes } = readImage(dir, req.params.name);
    return reply.type(type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=30').send(bytes);
  });
}
