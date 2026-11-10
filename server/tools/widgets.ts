import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { HOME_SLOTS, type HomeSlot, type WidgetAction, type WidgetBox, type WidgetDef, type WidgetValue, type WidgetView } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import type { MemoryApiExt } from '../memory/index.ts';
import { httpError, sha256, unifiedDiff } from '../memory/util.ts';
import type { Approvals } from './approvals.ts';
import { renderLibraryIcon } from './projectIcons.ts';
import { readJson } from './shared.ts';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 4096;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_BUFFER = 64 * 1024;
const MIN_INTERVAL_SEC = 5;
const REFRESH_MS = 30_000; // file and note widgets

const MIN_HEIGHT = 64;
const MAX_DESCRIPTION_CHARS = 500;

type RawWidget = { box?: unknown; slot?: unknown; height?: unknown; action?: unknown; view?: unknown; icon?: unknown; description?: unknown } & (
  | { id: string; title: string; type: 'command'; command: string; intervalSec?: number }
  | { id: string; title: string; type: 'file'; path: string; pointer?: string }
  | { id: string; title: string; type: 'note'; noteId: string }
  | { id: string; title: string; type: 'block'; content?: string }
);

function validBox(box: unknown): box is WidgetBox {
  const b = box as WidgetBox | null;
  return !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
}

const validSlot = (slot: unknown): slot is HomeSlot => HOME_SLOTS.includes(slot as HomeSlot);
const validHeight = (h: unknown): h is number => Number.isFinite(h) && (h as number) >= MIN_HEIGHT;
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function validAction(a: unknown): a is WidgetAction {
  const x = a as WidgetAction | null;
  return !!x && filled(x.label) && filled(x.cwd) && filled(x.prompt) && (x.readyWhen === undefined || filled(x.readyWhen));
}

const MAX_VIEW_BYTES = 256 * 1024;
// A view is a file of config/widgets/ named by the entry, never a path: nothing outside that folder is read as code.
const validViewName = (v: unknown): v is string => typeof v === 'string' && /^[\w][\w.-]*\.js$/.test(v);

function validShape(w: RawWidget): boolean {
  if (!w || typeof w.id !== 'string' || typeof w.title !== 'string') return false;
  if (w.type === 'command') return typeof w.command === 'string' && w.command.trim() !== '';
  if (w.type === 'file') return typeof w.path === 'string' && w.path !== '';
  if (w.type === 'note') return typeof w.noteId === 'string' && w.noteId !== '';
  if (w.type === 'block') return w.content === undefined || typeof w.content === 'string';
  return false;
}

export function readFileWidget(path: string, pointer?: string): string {
  const full = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  // The one exception to "any file": auth material is never read, whatever the config says.
  const real = realpathSync(full);
  if (basename(real) === '.credentials.json' || (real.endsWith('.key') && basename(dirname(real)) === 'sessions')) throw new Error('secret file');
  const fd = openSync(real, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    text = buf.toString('utf8', 0, readSync(fd, buf, 0, MAX_FILE_BYTES, 0));
  } finally {
    closeSync(fd);
  }
  if (!pointer) return text.trim().slice(0, MAX_VALUE_CHARS);
  let node: unknown = JSON.parse(text);
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    if (node === undefined) throw new Error(`no value at ${pointer}`);
  }
  return (typeof node === 'string' ? node : JSON.stringify(node)).slice(0, MAX_VALUE_CHARS);
}

export function createWidgets(ctx: Ctx, approvals: Approvals) {
  const file = join(ctx.paths.config, 'widgets.json');
  const values = new Map<string, WidgetValue>();
  const timers = new Map<string, { sig: string; timer: NodeJS.Timeout; running: boolean }>();

  function raw(): RawWidget[] {
    const data = readJson<unknown>(file);
    return Array.isArray(data) ? (data as RawWidget[]).filter(validShape) : [];
  }

  // A widget in the trash runs nothing: its command and its file wait until it comes back.
  function live(): RawWidget[] {
    const hidden = readJson<{ home?: { hidden?: unknown } }>(join(ctx.paths.config, 'settings.json'))?.home?.hidden;
    return Array.isArray(hidden) ? raw().filter((w) => !hidden.includes(w.id)) : raw();
  }

  function toDef(w: RawWidget): WidgetDef {
    const box = { ...(validSlot(w.slot) ? { slot: w.slot } : {}), ...(validHeight(w.height) ? { height: w.height } : {}), ...(validBox(w.box) ? { box: w.box } : {}), ...(validAction(w.action) ? { action: w.action } : {}), ...(validViewName(w.view) ? { view: viewOf(w.view) } : {}), ...(filled(w.icon) ? { icon: w.icon } : {}), ...(filled(w.description) ? { description: w.description.slice(0, MAX_DESCRIPTION_CHARS) } : {}) };
    if (w.type === 'command') {
      return { id: w.id, title: w.title, type: 'command', command: w.command, intervalSec: interval(w), approved: approvals.isApproved(w.command), ...box };
    }
    if (w.type === 'file') return { id: w.id, title: w.title, type: 'file', path: w.path, ...(w.pointer ? { pointer: w.pointer } : {}), approved: true, ...box };
    if (w.type === 'block') return { id: w.id, title: w.title, type: 'block', ...(w.content ? { content: w.content } : {}), approved: true, ...box };
    return { id: w.id, title: w.title, type: 'note', noteId: w.noteId, approved: true, ...box };
  }

  function interval(w: { intervalSec?: number }): number {
    return Math.max(Number(w.intervalSec) || 60, MIN_INTERVAL_SEC);
  }

  function publish(value: WidgetValue, force: boolean) {
    const prev = values.get(value.id);
    values.set(value.id, value);
    if (force || prev?.value !== value.value || prev?.error !== value.error) ctx.broadcast({ t: 'widget', value });
  }

  function runCommand(id: string, command: string) {
    const slot = timers.get(id);
    if (!slot || slot.running) return;
    if (!approvals.isApproved(command)) return;
    slot.running = true;
    execFile('bash', ['-c', command], { cwd: ctx.paths.repo, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, killSignal: 'SIGKILL' }, (err, stdout) => {
      slot.running = false;
      if (timers.get(id) !== slot) return; // replaced or removed while running: this result is stale
      const output = stdout.trim().slice(0, MAX_VALUE_CHARS);
      const failed = err && (err as { code?: unknown }).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      publish({ id, value: output || null, updatedAt: Date.now(), error: failed ? (err.killed ? 'timeout' : `exit ${err.code ?? 'error'}`) : null }, true);
    });
  }

  function readStatic(w: RawWidget): WidgetValue | null {
    if (w.type === 'file') {
      try {
        return { id: w.id, value: readFileWidget(w.path, w.pointer), updatedAt: Date.now(), error: null };
      } catch (err) {
        return { id: w.id, value: null, updatedAt: null, error: (err as Error).message.slice(0, 200) };
      }
    }
    if (w.type === 'note') {
      const head = (ctx.memory as MemoryApiExt | null)?.noteHead?.(w.noteId) ?? null;
      return { id: w.id, value: head, updatedAt: head === null ? null : Date.now(), error: head === null ? 'note not found' : null };
    }
    return null;
  }

  function refreshStatic() {
    for (const w of live()) {
      const value = readStatic(w);
      if (value) publish(value, false);
    }
  }

  function stop(id: string) {
    const slot = timers.get(id);
    if (slot) clearInterval(slot.timer);
    timers.delete(id);
  }

  // Unchanged widgets keep their timers. A changed command loses its timer: the new hash needs its own approval.
  function reload() {
    const current = live();
    const ids = new Set(current.map((w) => w.id));
    for (const id of [...timers.keys()]) if (!ids.has(id)) stop(id);
    for (const id of [...values.keys()]) if (!ids.has(id)) values.delete(id);
    for (const w of current) {
      if (w.type !== 'command') continue;
      const sig = `${sha256(w.command)}|${interval(w)}`;
      if (timers.get(w.id)?.sig === sig) continue;
      stop(w.id);
      if (!approvals.isApproved(w.command)) {
        publish({ id: w.id, value: null, updatedAt: null, error: 'pending approval' }, false);
        continue;
      }
      const timer = setInterval(() => runCommand(w.id, w.command), interval(w) * 1000);
      timer.unref();
      timers.set(w.id, { sig, timer, running: false });
      runCommand(w.id, w.command);
    }
    refreshStatic();
  }

  // The icon is drawn by the server from the library, like a plugin's: the interface does not carry every lucide icon.
  async function list(): Promise<{ defs: WidgetDef[]; values: WidgetValue[] }> {
    refreshStatic();
    const defs = await Promise.all(raw().map(async (w) => {
      const def = toDef(w);
      const svg = def.icon ? await renderLibraryIcon(def.icon) : null;
      return svg ? { ...def, iconSvg: svg } : def;
    }));
    return { defs, values: [...values.values()] };
  }

  function writeConfig(next: RawWidget[], action: string, target: string) {
    const before = JSON.stringify(raw(), null, 2);
    const text = JSON.stringify(next, null, 2);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text + '\n');
    ctx.audit(action, target, unifiedDiff(before, text, 'config/widgets.json'));
    reload();
    ctx.invalidate('widgets');
  }

  function add(body: Record<string, unknown>): WidgetDef {
    const { id: _id, approved: _approved, ...rest } = body;
    const widget = { ...rest, id: randomUUID().slice(0, 8) } as RawWidget;
    if (!validShape(widget)) throw httpError(400, 'bad widget');
    writeConfig([...raw(), widget], 'widget.add', widget.id);
    return toDef(widget);
  }

  function remove(id: string) {
    const current = raw();
    if (!current.some((w) => w.id === id)) throw httpError(404, 'widget not found');
    writeConfig(current.filter((w) => w.id !== id), 'widget.remove', id);
  }

  // The first move is what retires an old box: the height it had stays, the rest was a place on some window.
  function place(id: string, body: unknown): WidgetDef {
    const { slot, height } = (body ?? {}) as { slot?: unknown; height?: unknown };
    if (!validSlot(slot)) throw httpError(400, 'bad slot');
    if (height !== undefined && !validHeight(height)) throw httpError(400, 'bad height');
    const current = raw();
    const widget = current.find((c) => c.id === id);
    if (!widget) throw httpError(404, 'widget not found');
    const { box, ...rest } = widget;
    const kept = height ?? (validHeight(widget.height) ? widget.height : validBox(box) ? Math.max(MIN_HEIGHT, box.h) : undefined);
    const next = { ...rest, slot, ...(kept === undefined ? {} : { height: kept }) } as RawWidget;
    writeConfig(current.map((c) => (c.id === id ? next : c)), 'widget.move', id);
    return toDef(next);
  }

  function viewText(name: string): string | null {
    try {
      const path = join(ctx.paths.config, 'widgets', name);
      return statSync(path).size > MAX_VIEW_BYTES ? null : readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  function viewOf(name: string): WidgetView {
    const text = viewText(name);
    return { file: name, sha: text === null ? null : sha256(text), approved: text !== null && approvals.isApproved(text) };
  }

  function viewEntry(id: string): { file: string; text: string } {
    const w = raw().find((x) => x.id === id);
    if (!w) throw httpError(404, 'widget not found');
    if (!validViewName(w.view)) throw httpError(404, 'the widget has no view');
    const text = viewText(w.view);
    if (text === null) throw httpError(404, `config/widgets/${w.view} is missing`);
    return { file: w.view, text };
  }

  // The code to review before approving it: text, never run here.
  function viewSource(id: string): { file: string; sha: string; text: string } {
    const { file, text } = viewEntry(id);
    return { file, sha: sha256(text), text };
  }

  // What the interface imports: approved code only, so editing the file alone can never run anything.
  function viewModule(id: string): string {
    const { text } = viewEntry(id);
    if (!approvals.isApproved(text)) throw httpError(403, 'pending approval');
    return text;
  }

  // One approval covers what the widget runs: its command and its view, each as the user saw it.
  function approve(id: string, seen?: unknown, seenView?: unknown): WidgetDef {
    const w = raw().find((x) => x.id === id);
    if (!w) throw httpError(404, 'widget not found');
    const view = validViewName(w.view) ? viewText(w.view) : null;
    if (w.type !== 'command' && view === null) return toDef(w);
    if (w.type === 'command' && seen !== undefined && seen !== w.command) throw httpError(409, 'the command changed: review it again');
    if (view !== null && seenView !== undefined && seenView !== sha256(view)) throw httpError(409, 'the view changed: review it again');
    if (w.type === 'command') approvals.approve(w.command, `widget:${id}`);
    if (view !== null) approvals.approve(view, `widget:${id}:view`);
    stop(id); // the pending state had no timer, but an approval must always restart cleanly
    reload();
    ctx.invalidate('widgets');
    return toDef(w);
  }

  const refreshTimer = setInterval(refreshStatic, REFRESH_MS);
  refreshTimer.unref();

  function close() {
    clearInterval(refreshTimer);
    for (const id of [...timers.keys()]) stop(id);
  }

  return { list, add, remove, place, approve, viewSource, viewModule, reload, close };
}
