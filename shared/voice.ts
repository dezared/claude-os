// Local speech to text: the models, the speech languages, the "voice" settings key and the status of GET /api/voice.

// The speech models the user can download. Every one is an ONNX export for transformers.js, pinned to a revision; `bytes` is what the
// engine downloads at q8 from that revision (measured), for the size shown before the download.
export const VOICE_MODELS = {
  'whisper-small': { repo: 'onnx-community/whisper-small', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732', bytes: 251_846_613 },
  'whisper-large-v3-turbo': { repo: 'onnx-community/whisper-large-v3-turbo', revision: '360ebcde2559d60bb474678be3c1de9ef347d01a', bytes: 1_087_527_940 },
  'whisper-large-v3-turbo-russian': { repo: 'onnx-community/whisper-large-v3-turbo-russian-ONNX', revision: 'eb0f8fca31076c927cb4ca93a10c8f9150d411eb', bytes: 1_602_693_644 },
} as const;
export type VoiceModelId = keyof typeof VOICE_MODELS;
export const VOICE_MODEL_IDS = Object.keys(VOICE_MODELS) as VoiceModelId[];

// The speech language: 'auto' lets the model detect it, the rest are Whisper language codes.
export const VOICE_LANGUAGES = ['auto', 'ru', 'en', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'tr', 'zh', 'ja'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

// config/settings.json, key "voice". Without a stored language the profile's one applies when Whisper knows it, else English.
export interface VoiceOptions {
  model: VoiceModelId;
  language: VoiceLanguage;
}

export interface VoiceStatus {
  state: 'off' | 'downloading' | 'ready'; // of the chosen model
  model: VoiceModelId; // the chosen one
  installed: VoiceModelId[];
  modelBytes: number; // download size of the model
  diskBytes: number; // what is really in `dir` now
  downloaded: number | null; // while downloading
  dir: string;
  error: string | null;
}
