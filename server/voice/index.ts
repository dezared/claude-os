// Local speech to text. The browser records, because only it has the microphone (the server runs inside WSL), and sends PCM over loopback.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import type { VoiceStatus } from '../../shared/contract.ts';
import { decodePcm16, trimSilence } from './audio.ts';

const VOICE_MODEL = 'whisper-small';
const MODEL_BYTES = 251_846_613; // the files of the revision pinned in engine.ts
const IDLE_KILL_MS = 10 * 60_000; // the loaded model holds over a gigabyte

export type SpeechLanguage = 'ru' | 'en';
export type EngineRequest =
  | { type: 'load'; dir: string; download: boolean }
  | { type: 'transcribe'; id: number; dir: string; pcm: string; language: SpeechLanguage };
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

export function registerVoice(ctx: Ctx): void {
  const { app } = ctx;
  const root = join(ctx.paths.data, 'voice');
  const modelDir = join(root, 'model');
  const marker = join(root, 'installed'); // written after the whole model has loaded once
  let worker: ChildProcess | null = null;
  let downloading = false;
  let downloaded = 0;
  let error: string | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

  const status = (): VoiceStatus => ({
    state: downloading ? 'downloading' : existsSync(marker) ? 'ready' : 'off',
    model: VOICE_MODEL,
    modelBytes: MODEL_BYTES,
    diskBytes: dirBytes(modelDir),
    downloaded: downloading ? downloaded : null,
    dir: modelDir,
    error,
  });

  const setDownloading = (on: boolean) => {
    downloading = on;
    ctx.setBusy('voice-download', on);
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
      writeFileSync(marker, `${new Date().toISOString()} ${VOICE_MODEL}\n`);
      setDownloading(false);
      touch();
      ctx.audit('voice.install', VOICE_MODEL);
    } else if (m.type === 'error' && m.id === null) {
      error = m.message;
      setDownloading(false);
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
        setDownloading(false);
      }
    });
    worker = child;
    return child;
  };

  app.get('/api/voice', async () => status());

  // The only request that downloads anything, and only the user's explicit "enable" sends it.
  app.post('/api/voice/enable', async () => {
    if (!downloading && !existsSync(marker)) {
      error = null;
      downloaded = 0;
      mkdirSync(modelDir, { recursive: true });
      setDownloading(true);
      startWorker().send({ type: 'load', dir: modelDir, download: true } satisfies EngineRequest);
    }
    return status();
  });

  // Sent when recording starts: the model loads while the user speaks, not after.
  app.post('/api/voice/warm', async () => {
    if (!downloading && existsSync(marker)) {
      startWorker().send({ type: 'load', dir: modelDir, download: false } satisfies EngineRequest);
      touch();
    }
    return { ok: true };
  });

  app.delete('/api/voice/model', async () => {
    stopWorker();
    failAll('voice model removed');
    error = null;
    rmSync(root, { recursive: true, force: true });
    setDownloading(false);
    ctx.audit('voice.remove', VOICE_MODEL);
    return status();
  });

  app.post<{ Body: { pcm?: unknown } }>('/api/voice/transcribe', async (req) => {
    if (typeof req.body?.pcm !== 'string') throw httpError(400, 'pcm must be base64');
    if (!existsSync(marker) || downloading) throw httpError(409, 'voice model is not installed');
    const speech = trimSilence(decodePcm16(req.body.pcm));
    if (!speech) return { text: '' };
    const started = Date.now();
    const id = nextId++;
    const samples = Buffer.from(speech.buffer, speech.byteOffset, speech.byteLength).toString('base64');
    const text = await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      ctx.setBusy('voice-transcribe', true);
      // The profile's language is the user's speech; the model knows these two well, anything else gets English.
      const language: SpeechLanguage = ctx.settings?.profile()?.language === 'ru' ? 'ru' : 'en';
      startWorker().send({ type: 'transcribe', id, dir: modelDir, pcm: samples, language } satisfies EngineRequest);
    });
    touch();
    return { text, ms: Date.now() - started };
  });

  app.addHook('onClose', async () => stopWorker());
}
