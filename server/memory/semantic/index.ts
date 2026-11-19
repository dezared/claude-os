// Search of notes by meaning: a local embedding model, a vector per note kept in data/, fused with the FTS hits. Notes are
// in English and the user asks in Russian or in other words; FTS alone misses a note that says the same thing differently.
// Until the model is downloaded and the vectors cover the notes, search is FTS alone, as before.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEMANTIC_MODEL, type SemanticStatus } from '../../../shared/memorySemantic.ts';
import type { Ctx } from '../../context.ts';
import type { SearchDoc, SearchHit } from '../search.ts';
import { createBuilder } from './build.ts';
import { fuse } from './fuse.ts';
import { createVectors, loadVectors, type Vectors } from './vectors.ts';
import { createEngine } from './worker.ts';

export type EngineRequest =
  | { type: 'load'; dir: string; download: boolean }
  | { type: 'embed'; id: number; dir: string; texts: string[]; kind: 'query' | 'passage' };
export type EngineReply =
  | { type: 'progress'; loaded: number }
  | { type: 'loaded' }
  | { type: 'vectors'; id: number; data: string } // base64 of the Float32Array
  | { type: 'error'; id: number | null; message: string };

const WARM_MS = 5_000; // after the FTS index has had its start
const CHANGE_MS = 2_000;
const QUERY_MS = 2_500; // a cold engine loads in about a second; past this the search answers with FTS alone
const PROGRESS_MS = 2_000;

export interface SemanticSource {
  docs(): SearchDoc[];
  hits(paths: string[]): SearchHit[]; // the FTS index's rows for these notes, in this order
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((sum, e) => (e.isFile() ? sum + statSync(join(e.parentPath, e.name)).size : sum), 0);
}

function files(ctx: Ctx) {
  const root = join(ctx.paths.data, 'memory-semantic');
  return { root, model: join(root, 'model'), installed: join(root, 'installed'), off: join(root, 'off'), vectors: join(root, 'vectors.bin') };
}

// The vectors from the last run, or none.
function readVectors(path: string): Vectors {
  const buf = existsSync(path) ? readFileSync(path) : null;
  return buf ? loadVectors(buf, SEMANTIC_MODEL.id, SEMANTIC_MODEL.dims) : createVectors(SEMANTIC_MODEL.dims);
}

function writeVectors(path: string, vs: Vectors) {
  writeFileSync(`${path}.tmp`, vs.serialize(SEMANTIC_MODEL.id));
  renameSync(`${path}.tmp`, path);
}

// Ready once nearly every note has its vector: a few new ones are still found by FTS meanwhile.
const covers = (indexed: number, pending: number, total: number) => indexed > 0 && pending <= Math.max(50, total * 0.05);

function createSemantic(ctx: Ctx, source: SemanticSource) {
  const f = files(ctx);
  let vectors: Vectors | null = null;
  const run = { downloading: false, downloaded: 0, error: null as string | null, lastProgress: 0 };
  const installed = () => existsSync(f.installed);
  const enabled = () => !existsSync(f.off);
  const vs = () => (vectors ??= readVectors(f.vectors));

  const progress = (force = false) => {
    if (!force && Date.now() - run.lastProgress < PROGRESS_MS) return;
    run.lastProgress = Date.now();
    ctx.invalidate('memorySemantic');
  };
  const setDownloading = (on: boolean) => {
    run.downloading = on;
    ctx.setBusy('memory-semantic-download', on);
    progress(true);
  };

  const engine = createEngine(f.model, {
    progress(loaded) {
      run.downloaded = loaded;
      progress(true);
    },
    loaded() {
      if (!run.downloading) return;
      writeFileSync(f.installed, `${new Date().toISOString()} ${SEMANTIC_MODEL.id}\n`);
      ctx.audit('memory.semantic.install', SEMANTIC_MODEL.id);
      setDownloading(false);
      builder.sync();
    },
    failed(message) {
      run.error = message;
      setDownloading(false);
    },
  });

  const builder = createBuilder(vs, SEMANTIC_MODEL.dims, {
    docs: source.docs,
    embed: (texts) => engine.embed(texts, 'passage'),
    save: () => writeVectors(f.vectors, vs()),
    progress: () => progress(),
    error: (err) => ctx.app.log.warn(`memory vectors: ${err.message}`),
  });

  const active = () => installed() && enabled() && !run.downloading;
  return { f, run, vs, engine, builder, installed, enabled, active, setDownloading, progress, drop: () => void (vectors = null) };
}

type Semantic = ReturnType<typeof createSemantic>;

function status(s: Semantic): SemanticStatus {
  const { f, run } = s;
  const indexed = s.active() ? s.vs().size() : 0;
  return {
    state: run.downloading ? 'downloading' : s.installed() ? 'ready' : 'off',
    enabled: s.enabled(),
    model: SEMANTIC_MODEL.id,
    modelBytes: SEMANTIC_MODEL.bytes,
    diskBytes: dirBytes(f.model),
    downloaded: run.downloading ? run.downloaded : null,
    dir: f.model,
    error: run.error,
    indexed,
    total: s.builder.total(),
    indexBytes: s.active() ? s.vs().bytes() : 0,
  };
}

// The hits by meaning for q, or null when the vectors are not ready or the engine did not answer in time.
async function nearest(s: Semantic, q: string, opts: { project: string | null; depth: number }, source: SemanticSource): Promise<SearchHit[] | null> {
  if (!s.active() || !q.trim() || !covers(s.vs().size(), s.builder.pending(), s.builder.total())) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), QUERY_MS);
  });
  const query = await Promise.race([s.engine.embed([q], 'query').catch(() => null), late]).finally(() => clearTimeout(timer));
  if (!query) return null;
  return source.hits((await s.vs().topLater(query, opts.depth, opts.project)).map((h) => h.path));
}

function routes(ctx: Ctx, s: Semantic) {
  const { app } = ctx;
  app.get('/api/memory/semantic', async () => status(s));
  // Downloads the model when it is not there, and turns the search by meaning on.
  app.post('/api/memory/semantic/enable', async () => {
    rmSync(s.f.off, { force: true });
    if (!s.run.downloading && !s.installed()) {
      s.run.error = null;
      s.run.downloaded = 0;
      mkdirSync(s.f.model, { recursive: true });
      s.setDownloading(true);
      s.engine.download();
    } else if (s.installed()) s.builder.sync();
    ctx.audit('memory.semantic.enable', SEMANTIC_MODEL.id);
    return status(s);
  });
  // Off keeps the model and the vectors on disk; search is FTS alone and nothing is embedded.
  app.post('/api/memory/semantic/disable', async () => {
    mkdirSync(s.f.root, { recursive: true });
    writeFileSync(s.f.off, `${new Date().toISOString()}\n`);
    s.builder.stop();
    s.engine.stop();
    if (s.run.downloading) s.setDownloading(false); // stopping the engine ended the download
    ctx.audit('memory.semantic.disable', SEMANTIC_MODEL.id);
    s.progress(true);
    return status(s);
  });
  // Removes the model and the vectors; the toggle goes back to its default with them.
  app.delete('/api/memory/semantic/model', async () => {
    s.builder.stop();
    s.engine.stop();
    s.run.error = null;
    rmSync(s.f.root, { recursive: true, force: true });
    s.drop();
    s.setDownloading(false); // stopping the engine ended any download
    ctx.audit('memory.semantic.remove', SEMANTIC_MODEL.id);
    return status(s);
  });
}

export function registerSemantic(ctx: Ctx, source: SemanticSource) {
  const s = createSemantic(ctx, source);
  routes(ctx, s);
  let changeTimer: NodeJS.Timeout | null = null;
  const sync = () => {
    changeTimer = null;
    if (!s.active()) return;
    try {
      s.builder.sync();
    } catch (err) {
      ctx.app.log.error(err);
    }
  };
  const warm = setTimeout(sync, WARM_MS);
  warm.unref();
  ctx.app.addHook('onClose', async () => {
    clearTimeout(warm);
    if (changeTimer) clearTimeout(changeTimer);
    s.builder.stop();
    s.engine.stop();
  });
  return {
    // Notes changed on disk or through the editor: their vectors follow after a short debounce.
    changed() {
      changeTimer ??= setTimeout(sync, CHANGE_MS);
      changeTimer.unref();
    },
    // The FTS hits fused with the hits by meaning; the FTS hits alone, as they were, when there are none.
    async rank(q: string, fts: SearchHit[], opts: { project: string | null; limit: number; depth: number }): Promise<SearchHit[]> {
      const near = await nearest(s, q, opts, source).catch(() => null);
      return near ? fuse(fts, near, opts.limit) : fts.slice(0, opts.limit);
    },
  };
}
