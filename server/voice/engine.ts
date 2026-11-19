// The model runs in its own process: inference takes a gigabyte and several busy seconds that the server should not feel.
// index.ts forks this file, or the fake from CLAUDE_OS_VOICE_ENGINE in tests: that switch is the only seam.
import { cleanTranscript, splitAtPauses, trimSilence } from './audio.ts';
import { VOICE_MODELS, type VoiceLanguage, type VoiceModelId } from '../../shared/voice.ts';
import type { EngineReply, EngineRequest, SpeechLanguage } from './index.ts';

// Measured on CPU: q8 is faster than q4 for every model here. The Russian export's q8 decoder is not really quantized
// (as big as fp32), and still faster than its q4 one.
const DTYPE = 'q8';
// The prompt names the words of the trade. Measured on whisper-small: without the Russian one the Russian word for
// "deploy" comes out misspelled and "pull request" disappears.
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
  id: (token: string) => number;
  prompts: Record<SpeechLanguage, number[]>; // <|startofprev|>, the prompt, <|startoftranscript|>
  languages: number[]; // the language tokens, for detection
}
let loaded: { model: VoiceModelId; ready: Promise<Loaded> } | null = null;

async function loadModel(dir: string, download: boolean, name: VoiceModelId): Promise<Loaded> {
  const lib = await import('@huggingface/transformers');
  const { repo, revision } = VOICE_MODELS[name];
  lib.env.cacheDir = dir;
  // Past the first download the network is off for good.
  lib.env.allowRemoteModels = download;
  // Pinned here and not with the `revision` option: the library ignores that option when it looks for tokenizer files in the cache, and offline loading fails.
  lib.env.remotePathTemplate = `{model}/resolve/${revision}/`;
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
  const processor = await lib.AutoProcessor.from_pretrained(repo, options);
  const tokenizer = await lib.AutoTokenizer.from_pretrained(repo, options);
  const model = await lib.WhisperForConditionalGeneration.from_pretrained(repo, { ...options, dtype: DTYPE, device: 'cpu' });
  const id = (token: string) => tokenizer.convert_tokens_to_ids(token) as unknown as number;
  // The layout of OpenAI's initial_prompt: the context first, then the start of the transcript.
  const prompt = (lang: SpeechLanguage) => [id('<|startofprev|>'), ...tokenizer.encode(` ${PROMPTS[lang]}`, { add_special_tokens: false }), id('<|startoftranscript|>')];
  const languages = Object.values((model.generation_config as unknown as { lang_to_id: Record<string, number> }).lang_to_id);
  return { processor, tokenizer, model, id, prompts: { ru: prompt('ru'), en: prompt('en') }, languages };
}

// Keeps one model in memory: a changed choice in the settings frees the old one first.
async function use(dir: string, download: boolean, name: VoiceModelId): Promise<Loaded> {
  if (loaded?.model !== name) {
    const old = loaded?.ready;
    loaded = { model: name, ready: (async () => {
      await old?.then((o) => o.model.dispose(), () => {});
      return loadModel(dir, download, name);
    })() };
  }
  return loaded.ready;
}

type Logits = { data: Float32Array }[];
// For 'auto' the decoder picks the language token itself (only those are allowed), then transcribe and no timestamps are forced:
// left free it wanders into more language tokens. One pass over the audio, as with a fixed language.
function detectAndTranscribe(m: Loaded, at: number) {
  const keep = (row: { data: Float32Array }, ids: number[], forced: boolean) => {
    const saved = ids.map((k) => row.data[k]);
    row.data.fill(-Infinity);
    // A forced token may already be suppressed by the generation config, so it gets a finite score of its own.
    ids.forEach((k, j) => { row.data[k] = forced ? 0 : saved[j]; });
  };
  return (inputIds: unknown[][], logits: Logits) => {
    inputIds.forEach((ids, i) => {
      const step = ids.length - at;
      if (step === 0) keep(logits[i], m.languages, false);
      else if (step === 1) keep(logits[i], [m.id('<|transcribe|>')], true);
      else if (step === 2) keep(logits[i], [m.id('<|notimestamps|>')], true);
    });
    return logits;
  };
}

async function transcribe(pcm: Float32Array, m: Extract<EngineRequest, { type: 'transcribe' }>): Promise<string> {
  const loadedModel = await use(m.dir, false, m.model);
  const { processor, tokenizer, model } = loadedModel;
  const decoderStart = [...loadedModel.prompts[m.prompt], ...fixedLanguage(loadedModel, m.language)];
  const auto = m.language === 'auto' ? { logits_processor: [detectAndTranscribe(loadedModel, decoderStart.length)] } : {};
  const texts: string[] = [];
  for (const part of splitAtPauses(pcm)) {
    const speech = trimSilence(part);
    if (!speech) continue;
    const { input_features } = await processor(speech);
    const output = await model.generate({ inputs: input_features, decoder_input_ids: decoderStart, max_new_tokens: MAX_NEW_TOKENS, ...auto } as never);
    const ids = (output as unknown as { tolist(): bigint[][] }).tolist()[0].map(Number).slice(decoderStart.length);
    texts.push(cleanTranscript(tokenizer.decode(ids, { skip_special_tokens: true })));
  }
  return texts.filter(Boolean).join(' ');
}

// A chosen language goes in as the transcript's first tokens: nothing detects, nothing translates.
const fixedLanguage = (m: Loaded, language: VoiceLanguage) => (language === 'auto' ? [] : [m.id(`<|${language}|>`), m.id('<|transcribe|>'), m.id('<|notimestamps|>')]);

// One at a time: parallel runs would only fight for the same cores.
let queue: Promise<unknown> = Promise.resolve();
process.on('message', (m: EngineRequest) => {
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') {
        await use(m.dir, m.download, m.model);
        send({ type: 'loaded' });
      } else {
        const samples = new Float32Array(new Uint8Array(Buffer.from(m.pcm, 'base64')).buffer);
        send({ type: 'text', id: m.id, text: await transcribe(samples, m) });
      }
    } catch (err) {
      if (m.type === 'load') loaded = null;
      send({ type: 'error', id: m.type === 'load' ? null : m.id, message: (err as Error).message });
    }
  });
});
