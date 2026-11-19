// Watches the vault folder by folder with fs.watch: the vault itself, projects/, each project folder, global/ and
// its subfolders. A file watcher that stats every file it sees (chokidar walks all 100k notes at start) costs
// seconds of the server's time; a folder watch costs nothing per note and still names each changed path.
import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { safely } from './util.ts';

// Generated or owned by other modules: the Kanban+ board's cards, the index and the log; _state anywhere.
const OWN_TOP = ['kanban', '_index', '_log'];

export function watchDirs(vault: string, onPath: (path: string) => void): { close(): void } {
  const watchers = new Map<string, FSWatcher>();
  const ignored = (path: string) => relative(vault, path).split(sep).some((part, i) => part === '_state' || part.startsWith('.') || (i === 0 && OWN_TOP.includes(part)));
  // Folders below these hold notes or more such folders; a project folder's own subfolders are no notes.
  const deep = (dir: string) => {
    const parts = relative(vault, dir).split(sep).filter(Boolean);
    return parts.length === 0 || (parts[0] === 'projects' && parts.length === 1) || parts[0] === 'global';
  };

  function add(dir: string) {
    if (watchers.has(dir) || ignored(dir)) return;
    const w = safely<FSWatcher | null>(() => watch(dir, (_event, name) => changed(dir, name)), null);
    if (!w) return;
    w.on('error', () => drop(dir));
    watchers.set(dir, w);
    if (!deep(dir)) return;
    for (const e of safely(() => readdirSync(dir, { withFileTypes: true }), [])) if (e.isDirectory()) add(join(dir, e.name));
  }

  function drop(dir: string) {
    watchers.get(dir)?.close();
    watchers.delete(dir);
  }

  function changed(dir: string, name: string | Buffer | null) {
    const path = name ? join(dir, String(name)) : dir;
    if (ignored(path)) return;
    if (path !== dir && deep(dir)) {
      if (safely(() => statSync(path).isDirectory(), false)) add(path);
      else for (const w of watchers.keys()) if (w === path || w.startsWith(path + sep)) drop(w);
    }
    onPath(path);
  }

  add(vault);
  return {
    close() {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
