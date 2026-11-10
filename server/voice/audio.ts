// What happens to the audio between the browser and the model. No dependencies, so the tests need no model.
export const SAMPLE_RATE = 16_000;
const FRAME = Math.round(SAMPLE_RATE * 0.03);
const MIN_SPEECH_SEC = 0.2;
const MARGIN_SEC = 0.25;
const WINDOW_SEC = 28; // Whisper sees 30 s at a time
const PAUSE_SEARCH_SEC = 6;

export function decodePcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

function frameLevels(pcm: Float32Array): Float32Array {
  const levels = new Float32Array(Math.floor(pcm.length / FRAME));
  for (let f = 0; f < levels.length; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i] * pcm[i];
    levels[f] = Math.sqrt(sum / FRAME);
  }
  return levels;
}

// Whisper invents subtitle credits on silence, so silence never reaches it. Null: nobody spoke.
export function trimSilence(pcm: Float32Array): Float32Array | null {
  const levels = frameLevels(pcm);
  if (levels.length === 0) return null;
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.1)];
  const threshold = Math.max(0.004, floor * 3);
  let first = -1;
  let last = -1;
  let speech = 0;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] <= threshold) continue;
    if (first < 0) first = f;
    last = f;
    speech++;
  }
  if (speech * FRAME < MIN_SPEECH_SEC * SAMPLE_RATE) return null;
  const margin = MARGIN_SEC * SAMPLE_RATE;
  return pcm.subarray(Math.max(0, first * FRAME - margin), Math.min(pcm.length, (last + 1) * FRAME + margin));
}

// Long dictation is cut at the quietest moment before each window ends: no overlap, so there is no text to merge.
export function splitAtPauses(pcm: Float32Array): Float32Array[] {
  const window = WINDOW_SEC * SAMPLE_RATE;
  const parts: Float32Array[] = [];
  let start = 0;
  while (pcm.length - start > window) {
    const from = start + (WINDOW_SEC - PAUSE_SEARCH_SEC) * SAMPLE_RATE;
    const levels = frameLevels(pcm.subarray(from, start + window));
    let quietest = levels.length - 1;
    for (let f = levels.length - 1; f >= 0; f--) if (levels[f] < levels[quietest]) quietest = f;
    const cut = from + quietest * FRAME;
    parts.push(pcm.subarray(start, cut));
    start = cut;
  }
  parts.push(pcm.subarray(start));
  return parts;
}

// Credits from the subtitled films Whisper was trained on: on a noisy pause it writes them instead of nothing.
const ONLY_CREDITS = /^(?:субтитры (?:сделал|создавал) \S+|субтитр\S*|редактор субтитров|корректор|[а-я]\.\s?[а-я]\S*|продолжение следует|спасибо за просмотр|подписывайтесь на канал|[\s.,!…-])+$/iu; // shippable-allow: Whisper credits in Russian

export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (ONLY_CREDITS.test(text)) return '';
  // A decoder stuck in a loop repeats one word or phrase; four times in a row nobody says it.
  return text.replace(/([\p{L}\p{N}][\p{L}\p{N} -]{0,40}?)(?:[\s,.]+\1){3,}/gu, '$1');
}
