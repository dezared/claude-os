// Shipped defaults reach config/ without touching what the user has: a missing file is copied, a missing settings
// key is added, a shipped list record the install has never seen is appended once. Nothing existing is rewritten.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type BootstrapReport = { copied: string[]; appended: Record<string, string[]>; keysAdded: string[]; skippedInvalid: string[] };

const SEEN = '.shipped-seen.json';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Seen = Record<string, string[]>;

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (v: unknown): string | null => (isObject(v) && typeof v.id === 'string' ? v.id : null);
const ids = (list: Json[]) => list.map(idOf).filter((id): id is string => id !== null);

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const stringify = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// null: the file is there but unreadable. Guessing would re-offer records the user deleted, so lists wait instead.
function readSeen(file: string): Seen | null {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!isObject(raw) || !Object.values(raw).every((v) => Array.isArray(v) && v.every((id) => typeof id === 'string'))) return null;
  return raw as Seen;
}

// Adds the keys of `shipped` that `user` lacks, at any depth. Returns the dotted paths it added.
function addMissing(user: Record<string, Json>, shipped: Record<string, Json>, prefix = ''): string[] {
  const added: string[] = [];
  for (const [key, value] of Object.entries(shipped)) {
    if (!Object.hasOwn(user, key)) {
      user[key] = value;
      added.push(prefix + key);
    } else if (isObject(user[key]) && isObject(value)) {
      added.push(...addMissing(user[key], value, `${prefix}${key}.`));
    }
  }
  return added;
}

export function bootstrapConfig(defaultsDir: string, configDir: string): BootstrapReport {
  const report: BootstrapReport = { copied: [], appended: {}, keysAdded: [], skippedInvalid: [] };
  const seenFile = join(configDir, SEEN);
  const seen = readSeen(seenFile);
  if (!seen) report.skippedInvalid.push(SEEN);
  const seenBefore = seen && existsSync(seenFile) ? stringify(seen) : null;
  mkdirSync(configDir, { recursive: true });

  for (const name of jsonFiles(defaultsDir)) {
    try {
      bootstrapFile(name);
    } catch {
      report.skippedInvalid.push(name); // a broken shipped file or a failed write: the other files still land
    }
  }

  if (seen && stringify(seen) !== seenBefore) write(seenFile, stringify(seen));
  return report;

  function bootstrapFile(name: string): void {
    const text = readFileSync(join(defaultsDir, name), 'utf8');
    const shipped = JSON.parse(text) as Json;
    const target = join(configDir, name);

    if (!existsSync(target)) {
      write(target, text);
      report.copied.push(name);
      if (seen && Array.isArray(shipped)) seen[name] = [...new Set([...(seen[name] ?? []), ...ids(shipped)])];
      return;
    }

    let user: Json;
    try { user = JSON.parse(readFileSync(target, 'utf8')) as Json; } catch {
      report.skippedInvalid.push(name);
      return;
    }

    if (Array.isArray(shipped) && Array.isArray(user)) {
      if (!seen) return;
      const present = new Set(ids(user));
      // No record for this file yet (first run): what the install already holds counts as offered.
      const offered = new Set(seen[name] ?? present);
      const fresh = shipped.filter((r) => { const id = idOf(r); return id !== null && !offered.has(id) && !present.has(id); });
      for (const id of ids(shipped)) if (present.has(id)) offered.add(id);
      for (const r of fresh) offered.add(idOf(r)!);
      if (fresh.length) {
        write(target, stringify([...user, ...fresh]));
        report.appended[name] = ids(fresh);
      }
      seen[name] = [...offered]; // after the write: a failed append must be offered again next start
    } else if (isObject(shipped) && isObject(user)) {
      const added = addMissing(user, shipped);
      if (added.length) {
        write(target, stringify(user));
        report.keysAdded.push(...added);
      }
    } else {
      report.skippedInvalid.push(name); // a list where an object belongs, or the other way round: not ours to fix
    }
  }
}
