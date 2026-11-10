// The model runs in its own process: inference takes a gigabyte and several busy seconds that the server should not feel.
// index.ts forks this file, or the fake from CLAUDE_OS_VOICE_ENGINE in tests: that switch is the only seam.
import { cleanTranscript, splitAtPauses, trimSilence } from './audio.ts';
import type { EngineReply, EngineRequest, SpeechLanguage } from './index.ts';

const MODEL = 'onnx-community/whisper-small';
const REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732';
const DTYPE = 'q8';
// The speech language is the profile's; the prompt names the words of the trade in it. Measured on this model: without
// the Russian one the Russian word for "deploy" comes out misspelled and "pull request" disappears.
const PROMPTS: Record<SpeechLanguage, string> = {
  ru: 'Разговор о программировании: деплой, бэкенд, фронтенд, API, Git, pull request, commit, merge, Docker, TypeScript, React, Node.js, Claude.', // shippable-allow: the prompt for Russian speech
  en: 'A conversation about programming: deploy, backend, frontend, API, Git, pull request, commit, merge, Docker, TypeScript, React, Node.js, Claude.',
};
const MAX_NEW_TOKENS = 300;

const send = (m: EngineReply) => process.send?.(m);
process.on('disconnect', () => process.exit(0));

type Lib = typeof import('@huggingface/transformers');
interface Loaded {
  processor: Awaited<ReturnType<Lib['AutoProcessor']['from_pretrained']>>;
  tokenizer: Awaited<ReturnType<Lib['AutoTokenizer']['from_pretrained']>>;
  model: Awaited<ReturnType<Lib['WhisperForConditionalGeneration']['from_pretrained']>>;
  decoderStart: Record<SpeechLanguage, number[]>;
}
let loaded: Promise<Loaded> | null = null;

async function loadModel(dir: string, download: boolean): Promise<Loaded> {
  const lib = await import('@huggingface/transformers');
  lib.env.cacheDir = dir;
  // Past the first download the network is off for good.
  lib.env.allowRemoteModels = download;
  // Pinned here and not with the `revision` option: the library ignores that option when it looks for tokenizer files in the cache, and offline loading fails.
  lib.env.remotePathTemplate = `{model}/resolve/${REVISION}/`;
  const seen = new Map<string, number>();
  let lastReport = 0;
  const options = {
    progress_callback: (p: { status: string; file?: string; loaded?: number }) => {
      if (p.status !== 'progress' || !p.file) return;
      seen.set(p.file, p.loaded ?? 0);
      if (Date.now() - lastReport < 300) return;
      lastReport = Date.now();
      send({ type: 'progress', loaded: [...seen.values()].reduce((a, b) => a + b, 0) });
    },
  };
  const processor = await lib.AutoProcessor.from_pretrained(MODEL, options);
  const tokenizer = await lib.AutoTokenizer.from_pretrained(MODEL, options);
  const model = await lib.WhisperForConditionalGeneration.from_pretrained(MODEL, { ...options, dtype: DTYPE, device: 'cpu' });
  const id = (token: string) => tokenizer.convert_tokens_to_ids(token) as unknown as number;
  // The layout of OpenAI's initial_prompt: the context first, then the language and task transcribe. Nothing detects, nothing translates.
  const start = (lang: SpeechLanguage) => [
    id('<|startofprev|>'), ...tokenizer.encode(` ${PROMPTS[lang]}`, { add_special_tokens: false }),
    id('<|startoftranscript|>'), id(`<|${lang}|>`), id('<|transcribe|>'), id('<|notimestamps|>'),
  ];
  return { processor, tokenizer, model, decoderStart: { ru: start('ru'), en: start('en') } };
}

async function transcribe(pcm: Float32Array, dir: string, language: SpeechLanguage): Promise<string> {
  loaded ??= loadModel(dir, false);
  const { processor, tokenizer, model, decoderStart: starts } = await loaded;
  const decoderStart = starts[language];
  const texts: string[] = [];
  for (const part of splitAtPauses(pcm)) {
    const speech = trimSilence(part);
    if (!speech) continue;
    const { input_features } = await processor(speech);
    const output = await model.generate({ inputs: input_features, decoder_input_ids: decoderStart, max_new_tokens: MAX_NEW_TOKENS } as never);
    const ids = (output as unknown as { tolist(): bigint[][] }).tolist()[0].map(Number).slice(decoderStart.length);
    texts.push(cleanTranscript(tokenizer.decode(ids, { skip_special_tokens: true })));
  }
  return texts.filter(Boolean).join(' ');
}

// One at a time: parallel runs would only fight for the same cores.
let queue: Promise<unknown> = Promise.resolve();
process.on('message', (m: EngineRequest) => {
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') {
        loaded ??= loadModel(m.dir, m.download);
        await loaded;
        send({ type: 'loaded' });
      } else {
        const samples = new Float32Array(new Uint8Array(Buffer.from(m.pcm, 'base64')).buffer);
        send({ type: 'text', id: m.id, text: await transcribe(samples, m.dir, m.language) });
      }
    } catch (err) {
      if (m.type === 'load') loaded = null;
      send({ type: 'error', id: m.type === 'load' ? null : m.id, message: (err as Error).message });
    }
  });
});
