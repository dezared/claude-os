// The embedding model runs in its own process: it holds about 600 MB, and a first build of a large vault keeps it busy for
// minutes that the server should not feel. index.ts forks this file, or the fake from CLAUDE_OS_SEMANTIC_ENGINE in tests.
import { SEMANTIC_MODEL } from '../../../shared/memorySemantic.ts';
import type { EngineReply, EngineRequest } from './index.ts';

// Measured on 4 cores: one note at a time is faster than batches (padding), and two threads leave the rest of the machine
// free at 29 ms a note; four threads gain 20%.
const THREADS = 2;
// e5 models are trained with these prefixes; without them a question and its answer land further apart.
const PREFIX = { query: 'query: ', passage: 'passage: ' } as const;

const send = (m: EngineReply) => process.send?.(m);
process.on('disconnect', () => process.exit(0));

type Lib = typeof import('@huggingface/transformers');
type Extractor = Awaited<ReturnType<Lib['pipeline']>>;
let loaded: Promise<Extractor> | null = null;

async function load(dir: string, download: boolean): Promise<Extractor> {
  const lib = await import('@huggingface/transformers');
  const { repo, revision } = SEMANTIC_MODEL;
  lib.env.cacheDir = dir;
  // Past the first download the network is off for good.
  lib.env.allowRemoteModels = download;
  // Pinned here and not with the `revision` option, as in server/voice/engine.ts: offline loading ignores that option.
  lib.env.remotePathTemplate = `{model}/resolve/${revision}/`;
  const seen = new Map<string, number>();
  let lastReport = 0;
  const progress_callback = (p: { status: string; file?: string; loaded?: number }) => {
    if (p.status !== 'progress' || !p.file) return;
    seen.set(p.file, p.loaded ?? 0);
    if (Date.now() - lastReport < 300) return;
    lastReport = Date.now();
    send({ type: 'progress', loaded: [...seen.values()].reduce((a, b) => a + b, 0) });
  };
  const options = { dtype: 'q8', device: 'cpu', progress_callback, session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 } };
  return lib.pipeline('feature-extraction', repo, options as never) as Promise<Extractor>;
}

async function embed(m: Extract<EngineRequest, { type: 'embed' }>): Promise<string> {
  loaded ??= load(m.dir, false);
  const extract = (await loaded) as (text: string, o: object) => Promise<{ data: Float32Array }>;
  const out = new Float32Array(m.texts.length * SEMANTIC_MODEL.dims);
  for (const [i, text] of m.texts.entries()) {
    const { data } = await extract(PREFIX[m.kind] + text, { pooling: 'mean', normalize: true });
    out.set(data, i * SEMANTIC_MODEL.dims);
  }
  return Buffer.from(out.buffer).toString('base64');
}

// One request at a time, a query ahead of the notes waiting to be embedded: a search should not wait for the build.
const waiting: EngineRequest[] = [];
let running = false;
async function run(m: EngineRequest) {
  try {
    if (m.type === 'load') {
      loaded = load(m.dir, m.download);
      await loaded;
      send({ type: 'loaded' });
    } else send({ type: 'vectors', id: m.id, data: await embed(m) });
  } catch (err) {
    if (m.type === 'load') loaded = null;
    send({ type: 'error', id: m.type === 'load' ? null : m.id, message: (err as Error).message });
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (waiting.length) await run(waiting.shift()!);
  running = false;
}

process.on('message', (m: EngineRequest) => {
  if (m.type === 'embed' && m.kind === 'query') waiting.unshift(m);
  else waiting.push(m);
  void drain();
});
