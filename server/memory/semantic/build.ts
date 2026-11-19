// Keeps the vectors in step with the notes: a plan diffs the notes against the vectors, then a pump embeds the missing ones
// a few at a time in the engine process. The server only diffs and stores; a first build of 100k notes runs for about
// 50 minutes in the background and is saved along the way, so a restart continues where it stopped.
import type { SearchDoc } from '../search.ts';
import type { Vectors } from './vectors.ts';

const BATCH = 8; // a search waits for at most one batch already in the engine: about a quarter of a second
const SAVE_MS = 60_000;
const TEXT_MAX = 2000; // one-fact notes are far shorter; a long one is judged by its start, like the model would at 512 tokens

// Only the note's text decides its vector: SearchDoc.sha also carries the project and the mtime.
const textSha = (d: SearchDoc) => d.sha.split(':')[0];

export function noteText(d: Pick<SearchDoc, 'name' | 'description' | 'body'>): string {
  return `${d.name.replaceAll('-', ' ')}. ${d.description ?? ''}\n${d.body}`.slice(0, TEXT_MAX);
}

export interface BuildHooks {
  docs(): SearchDoc[];
  embed(texts: string[]): Promise<Float32Array>;
  save(): void;
  progress(): void; // throttled by the caller
  error(err: Error): void;
}

// The notes whose text has no vector yet; vectors of gone notes are dropped and a moved note's project is updated in place.
function diff(vs: Vectors, docs: SearchDoc[]): { queue: SearchDoc[]; dirty: boolean } {
  const live = new Set<string>();
  const queue: SearchDoc[] = [];
  let dirty = false;
  for (const d of docs) {
    live.add(d.path);
    const known = vs.get(d.path);
    if (known?.sha !== textSha(d)) queue.push(d);
    else if (known.project !== d.project) {
      known.project = d.project;
      dirty = true;
    }
  }
  for (const path of vs.paths()) {
    if (live.has(path)) continue;
    vs.remove(path);
    dirty = true;
  }
  return { queue, dirty };
}

export function createBuilder(vectors: () => Vectors, dims: number, hooks: BuildHooks) {
  let queue: SearchDoc[] = [];
  let total = 0;
  let run = 0; // a stop() or a new pump ends the loop of an older run
  let active = -1; // the run whose loop is going

  async function pump(id: number) {
    active = id;
    let saved = Date.now();
    try {
      while (queue.length && id === run) {
        const batch = queue.splice(0, BATCH);
        const out = await hooks.embed(batch.map(noteText));
        if (id !== run) return;
        batch.forEach((d, i) => vectors().set({ path: d.path, sha: textSha(d), project: d.project }, out.subarray(i * dims, (i + 1) * dims)));
        hooks.progress();
        if (Date.now() - saved > SAVE_MS) {
          hooks.save();
          saved = Date.now();
        }
      }
      if (id === run) hooks.save();
    } catch (err) {
      hooks.error(err as Error);
    } finally {
      if (active === id) active = -1;
    }
  }

  return {
    // Diffs again and embeds what is missing; a pump already going takes the new queue.
    sync() {
      const docs = hooks.docs();
      const next = diff(vectors(), docs);
      queue = next.queue;
      total = docs.length;
      hooks.progress();
      if (queue.length && active !== run) void pump(++run);
      else if (!queue.length && next.dirty) hooks.save();
    },
    stop() {
      run++;
      queue = [];
    },
    pending: () => queue.length,
    total: () => total,
  };
}
