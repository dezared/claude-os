// Projects whose notes the server may rewrite (fixes, MEMORY.md, _index). A project joins when its wiki migration
// is applied and leaves on undo; every other project is only linted and searched, never written.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../context.ts';
import { safely } from './util.ts';

const fileOf = (paths: Pick<Paths, 'data'>) => join(paths.data, 'wiki-managed.json');

function managedSet(paths: Pick<Paths, 'data'>): Set<string> {
  const parsed = safely(() => JSON.parse(readFileSync(fileOf(paths), 'utf8')) as { projects?: unknown }, null);
  return new Set(Array.isArray(parsed?.projects) ? parsed.projects.filter((k): k is string => typeof k === 'string') : []);
}

export function isWikiManaged(paths: Pick<Paths, 'data'>, key: string | null): boolean {
  return key !== null && managedSet(paths).has(key);
}

export function setWikiManaged(paths: Pick<Paths, 'data'>, key: string, managed: boolean): void {
  const set = managedSet(paths);
  if (set.has(key) === managed) return;
  if (managed) set.add(key);
  else set.delete(key);
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(fileOf(paths), `${JSON.stringify({ projects: [...set].sort() }, null, 2)}\n`);
}
