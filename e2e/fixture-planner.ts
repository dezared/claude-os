// Planner notes and a small project tree, with made-up data, for UI tests. State lives per fixture server.
import { createHash } from 'node:crypto';
import type { FileEntry, PlannerFolder, PlannerNote, ProjectFile, RecoveryItem } from '../shared/contract.ts';
import { parseItem } from '../shared/plannerItems.ts';

const DIR = '/home/test/claude-os/data/planner';
const versioned = (note: PlannerNote): PlannerNote => ({ ...note, version: createHash('sha256').update(note.text).digest('hex').slice(0, 16) });

const TREE: Record<string, FileEntry[]> = {
  '': [
    { name: 'src', path: 'src', dir: true, size: null },
    { name: 'README.md', path: 'README.md', dir: false, size: 12 },
    { name: 'logo.png', path: 'logo.png', dir: false, size: 2048 },
    { name: 'dump.sql', path: 'dump.sql', dir: false, size: 5 * 1024 * 1024 },
    { name: 'my notes.md', path: 'my notes.md', dir: false, size: 5 },
  ],
  src: [{ name: 'config.ts', path: 'src/config.ts', dir: false, size: 24 }],
};

const FILES: Record<string, ProjectFile> = {
  'README.md': { path: 'README.md', size: 12, kind: 'text', text: '# alpha\n', truncated: false, sha: 'sha-readme' },
  'src/config.ts': { path: 'src/config.ts', size: 24, kind: 'text', text: 'export const a = 1;\nexport const b = 2;\n', truncated: false, sha: 'sha-config' },
  'logo.png': { path: 'logo.png', size: 2048, kind: 'binary', text: null, truncated: false, sha: null },
  'dump.sql': { path: 'dump.sql', size: 5 * 1024 * 1024, kind: 'text', text: 'select 1;\n', truncated: true, sha: null },
  'my notes.md': { path: 'my notes.md', size: 5, kind: 'text', text: 'hello', truncated: false, sha: 'sha-notes' },
};

export function plannerRoutes() {
  let seq = 0;
  let recovery: RecoveryItem[] = [];
  const notes: PlannerNote[] = [
    { id: '2026-11-01-обновить-брокер-aa11', path: `${DIR}/projects/alpha-service/очередь/2026-11-01-обновить-брокер-aa11.md`, title: 'Обновить брокер', text: 'Обновить брокер\nдо конца месяца', created: '2026-11-01T10:00:00.000Z', filed: true, topic: 'очередь', date: '2026-11-30', version: '' },
  ];
  let folders: PlannerFolder[] = [];
  return (m: string, path: string, search: URLSearchParams, body: unknown): [number, unknown] | null => {
    if (path === '/api/recovery' && m === 'GET') return [200, recovery];
    if (path === '/api/recovery/test-set' && m === 'POST') {
      recovery = body as RecoveryItem[];
      return [200, recovery];
    }
    const held = /^\/api\/recovery\/tabs\/([^/]+)\/queue\/([^/]+)(\/send)?$/.exec(path);
    if (held) {
      for (const r of recovery) if (r.kind === 'tab' && r.tabId === held[1]) r.queued = r.queued.filter((q) => q.id !== held[2]);
      recovery = recovery.filter((r) => r.kind !== 'tab' || r.interruptedAt !== null || r.queued.length > 0);
      return [200, { ok: true }];
    }
    const dismissed = /^\/api\/recovery\/(tabs|sessions)\/([^/]+)\/dismiss$/.exec(path);
    if (dismissed) {
      for (const r of recovery) if (r.kind === 'tab' && r.tabId === dismissed[2]) r.interruptedAt = null;
      recovery = recovery.filter((r) => (r.kind === 'tab' ? r.interruptedAt !== null || r.queued.length > 0 : r.sessionId !== dismissed[2]));
      return [200, { ok: true }];
    }
    if (path === '/api/planner' && m === 'GET') return [200, { dir: DIR, folders, notes: notes.map(versioned) }];
    if (path === '/api/planner/folders' && m === 'POST') {
      const folder = { id: `f${++seq}`, name: (body as { name: string }).name, color: '#5fa8d3' };
      folders.push(folder);
      return [200, folder];
    }
    if (path === '/api/planner/folders/order' && m === 'PUT') {
      const { ids } = body as { ids: string[] };
      folders = ids.map((id) => folders.find((f) => f.id === id)!);
      return [200, folders];
    }
    const shelf = /^\/api\/planner\/folders\/([^/]+)$/.exec(path);
    if (shelf && m === 'PATCH') {
      const folder = folders.find((f) => f.id === shelf[1])!;
      Object.assign(folder, body);
      return [200, folder];
    }
    if (shelf && m === 'DELETE') {
      folders = folders.filter((f) => f.id !== shelf[1]);
      for (const n of notes) if (n.folder === shelf[1]) n.folder = null;
      return [200, { ok: true }];
    }
    const into = /^\/api\/planner\/([^/]+)\/folder$/.exec(path);
    if (into && m === 'PUT') {
      notes.find((n) => n.id === decodeURIComponent(into[1]))!.folder = (body as { folder: string | null }).folder;
      return [200, { ok: true }];
    }
    if (path === '/api/planner' && m === 'POST') {
      const { text: raw, folder = null } = body as { text?: unknown; folder?: string | null };
      const text = String(raw).trim();
      const id = `2026-11-05-заметка-${++seq}`;
      const note: PlannerNote = { id, path: `${DIR}/inbox/${id}.md`, title: (parseItem(text.split('\n')[0])?.text ?? text.split('\n')[0]).slice(0, 80), text, created: new Date().toISOString(), filed: false, topic: null, date: null, version: '', folder };
      notes.unshift(note);
      return [200, versioned(note)];
    }
    if (path === '/api/planner/images' && m === 'POST') return [200, { path: `${DIR}/images/2026-11-05-shot${++seq}.png` }];
    const action = /^\/api\/planner\/([^/]+)\/(file|test-filed|test-changed)$/.exec(path);
    if (action && m === 'POST') {
      const note = notes.find((n) => n.id === decodeURIComponent(action[1]))!;
      if (action[2] === 'test-filed') { // what the service session's tool does: the file moves, the id and the text stay
        const { topic } = body as { topic: string };
        Object.assign(note, { filed: true, topic, path: `${DIR}/general/${topic}/${note.id}.md`, job: undefined });
      } else if (action[2] === 'test-changed') note.text = (body as { text: string }).text;
      else note.job = { state: 'running' };
      return [200, versioned(note)];
    }
    const single = /^\/api\/planner\/([^/]+)$/.exec(path);
    if (single && (m === 'GET' || m === 'PUT' || m === 'PATCH') && single[1] !== 'images') {
      const note = notes.find((n) => n.id === decodeURIComponent(single[1]));
      if (!note) return [404, { error: 'no note' }];
      if (m === 'PATCH') note.title = (body as { title: string }).title;
      if (m === 'PUT') {
        const { text, version } = body as { text: string; version: string };
        if (version !== versioned(note).version) return [409, { error: 'the note has changed: reload it' }];
        note.text = text;
      }
      return [200, versioned(note)];
    }
    const del = /^\/api\/planner\/([^/]+)$/.exec(path);
    if (del && m === 'DELETE') {
      notes.splice(notes.findIndex((n) => n.id === decodeURIComponent(del[1])), 1);
      return [200, { ok: true }];
    }
    if (/^\/api\/tabs\/[^/]+\/tree$/.test(path)) return [200, TREE[search.get('path') ?? ''] ?? []];
    if (/^\/api\/tabs\/[^/]+\/file$/.test(path)) {
      const file = FILES[search.get('path') ?? ''];
      return file ? [200, file] : [404, { error: 'no such file' }];
    }
    return null;
  };
}
