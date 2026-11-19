// Local speech to text. The browser records, because only it has the microphone (the server runs inside WSL), and sends PCM over loopback.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { VOICE_MODEL_IDS, VOICE_MODELS, type VoiceLanguage, type VoiceModelId, type VoiceOptions, type VoiceStatus } from '../../shared/voice.ts';
import { decodePcm16, trimSilence } from './audio.ts';
import { promptLanguage, voiceOptions } from './options.ts';

const IDLE_KILL_MS = 10 * 60_000; // the loaded model holds over a gigabyte

export type SpeechLanguage = 'ru' | 'en'; // the language of the jargon prompt
export type EngineRequest =
  | { type: 'load'; dir: string; download: boolean; model: VoiceModelId }
  | { type: 'transcribe'; id: number; dir: string; pcm: string; model: VoiceModelId; language: VoiceLanguage; prompt: SpeechLanguage };
export type EngineReply =
  | { type: 'progress'; loaded: number }
  | { type: 'loaded' }
  | { type: 'text'; id: number; text: string }
  | { type: 'error'; id: number | null; message: string };

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((sum, e) => (e.isFile() ? sum + statSync(join(e.parentPath, e.name)).size : sum), 0);
}

// All models share one cache folder, each under its repo. A marker is written after the whole model has loaded once;
// whisper-small keeps the name it had when it was the only model, so an existing install stays installed.
function modelFiles(root: string, model: VoiceModelId) {
  return { files: join(root, 'model', VOICE_MODELS[model].repo), marker: join(root, model === 'whisper-small' ? 'installed' : `installed-${model}`) };
}

const isInstalled = (root: string, model: VoiceModelId) => existsSync(modelFiles(root, model).marker);

function voiceStatus(root: string, model: VoiceModelId, run: { downloading: VoiceModelId | null; downloaded: number; error: string | null }): VoiceStatus {
  return {
    state: run.downloading === model ? 'downloading' : isInstalled(root, model) ? 'ready' : 'off',
    model,
    installed: VOICE_MODEL_IDS.filter((m) => isInstalled(root, m)),
    modelBytes: VOICE_MODELS[model].bytes,
    diskBytes: dirBytes(modelFiles(root, model).files),
    downloaded: run.downloading === model ? run.downloaded : null,
    dir: join(root, 'model'),
    error: run.error,
  };
}

export function registerVoice(ctx: Ctx): void {
  const { app } = ctx;
  const root = join(ctx.paths.data, 'voice');
  const modelDir = join(root, 'model');
  const options = (): VoiceOptions => ctx.settings?.voice() ?? voiceOptions(null, null);
  const installed = (model: VoiceModelId) => isInstalled(root, model);
  let worker: ChildProcess | null = null;
  let downloading: VoiceModelId | null = null;
  let downloaded = 0;
  let error: string | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

  const status = () => voiceStatus(root, options().model, { downloading, downloaded, error });

  const setDownloading = (model: VoiceModelId | null) => {
    downloading = model;
    ctx.setBusy('voice-download', model !== null);
    ctx.invalidate('voice');
  };

  const stopWorker = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const child = worker;
    worker = null; // first, so its exit does not read as a crash
    child?.kill();
  };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (waiting.size === 0) stopWorker();
    }, IDLE_KILL_MS);
    idleTimer.unref();
  };

  const failAll = (message: string) => {
    for (const w of waiting.values()) w.reject(httpError(500, message));
    waiting.clear();
    ctx.setBusy('voice-transcribe', false);
  };

  const onReply = (m: EngineReply) => {
    if (m.type === 'progress') {
      downloaded = m.loaded;
      ctx.invalidate('voice');
    } else if (m.type === 'loaded') {
      if (!downloading) return;
      writeFileSync(modelFiles(root, downloading).marker, `${new Date().toISOString()} ${downloading}\n`);
      ctx.audit('voice.install', downloading);
      setDownloading(null);
      touch();
    } else if (m.type === 'error' && m.id === null) {
      error = m.message;
      setDownloading(null);
    } else if (m.id !== null) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (waiting.size === 0) ctx.setBusy('voice-transcribe', false);
      if (m.type === 'text') w?.resolve(m.text);
      else w?.reject(httpError(500, m.message));
    }
  };

  const startWorker = (): ChildProcess => {
    if (worker) return worker;
    const child = fork(process.env.CLAUDE_OS_VOICE_ENGINE ?? join(import.meta.dirname, 'engine.ts'), {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--disable-warning=ExperimentalWarning'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-2000);
    });
    child.on('message', (m) => {
      if (worker === child) onReply(m as EngineReply);
    });
    child.on('exit', (code, signal) => {
      if (worker !== child) return;
      worker = null;
      const message = `voice engine stopped (${signal ?? code}): ${stderr.trim().slice(-300)}`;
      failAll(message);
      if (downloading) {
        error = message;
        setDownloading(null);
      }
    });
    worker = child;
    return child;
  };

  app.get('/api/voice', async () => status());

  // The only request that downloads anything, and only the user's explicit "enable" sends it. One download at a time.
  app.post('/api/voice/enable', async () => {
    const { model } = options();
    if (!downloading && !installed(model)) {
      error = null;
      downloaded = 0;
      mkdirSync(modelDir, { recursive: true });
      setDownloading(model);
      startWorker().send({ type: 'load', dir: modelDir, download: true, model } satisfies EngineRequest);
    }
    return status();
  });

  // Sent when recording starts: the model loads while the user speaks, not after. The engine swaps models when the choice changed.
  app.post('/api/voice/warm', async () => {
    const { model } = options();
    if (!downloading && installed(model)) {
      startWorker().send({ type: 'load', dir: modelDir, download: false, model } satisfies EngineRequest);
      touch();
    }
    return { ok: true };
  });

  // Removes the chosen model; the folder goes with the last one.
  app.delete('/api/voice/model', async () => {
    const { model } = options();
    stopWorker();
    failAll('voice model removed');
    error = null;
    const { files, marker } = modelFiles(root, model);
    rmSync(marker, { force: true });
    rmSync(files, { recursive: true, force: true });
    if (!VOICE_MODEL_IDS.some(installed)) rmSync(root, { recursive: true, force: true });
    setDownloading(null); // stopping the worker ended any download
    ctx.audit('voice.remove', model);
    return status();
  });

  app.post<{ Body: { pcm?: unknown } }>('/api/voice/transcribe', async (req) => {
    if (typeof req.body?.pcm !== 'string') throw httpError(400, 'pcm must be base64');
    const { model, language } = options();
    if (!installed(model) || downloading) throw httpError(409, 'voice model is not installed');
    const speech = trimSilence(decodePcm16(req.body.pcm));
    if (!speech) return { text: '' };
    const started = Date.now();
    const id = nextId++;
    const samples = Buffer.from(speech.buffer, speech.byteOffset, speech.byteLength).toString('base64');
    const text = await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      ctx.setBusy('voice-transcribe', true);
      const prompt = promptLanguage(language, ctx.settings?.profile()?.language ?? null);
      startWorker().send({ type: 'transcribe', id, dir: modelDir, pcm: samples, model, language, prompt } satisfies EngineRequest);
    });
    touch();
    return { text, ms: Date.now() - started };
  });

  app.addHook('onClose', async () => stopWorker());
}
