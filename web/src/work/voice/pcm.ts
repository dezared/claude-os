// The audio plumbing without the browser: tested in server/voice/voice.test.ts.
import { parseItem } from '../../../../shared/plannerItems.ts';

export type MicProblem = 'denied' | 'nodevice' | 'busy' | 'other';

export function micProblem(err: unknown): MicProblem {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'nodevice';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'other';
}

export function toPcm16(chunks: Float32Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    for (const v of chunk) out[at++] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  return out;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// 0..1 for the indicator. Speech sits around 0.02..0.2 RMS, the square root spreads it over the scale.
export function meterLevel(chunk: Float32Array): number {
  let sum = 0;
  for (const v of chunk) sum += v * v;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / (chunk.length || 1))) * 1.6);
}

// Replaces the selection, with a space where the text would otherwise stick to a neighbouring word.
export function insertAtCaret(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const left = before && !/\s$/.test(before) ? ' ' : '';
  const right = after && !/^[\s.,!?;:)]/.test(after) ? ' ' : '';
  const insert = left + text + right;
  return { value: before + insert + after, caret: before.length + insert.length };
}

// No `i` flag: with it \p{Lu} matches lowercase too. A sentence end counts because the model writes a pause that way: measured at 0.6 to 2 s of silence.
const ITEM_RU = /(?<![\p{L}\p{N}])[Пп]ункт(?![\p{L}\p{N}])(?:\s+(?:\d+|первый|второй|третий|четв[её]ртый|пятый|шестой|седьмой|восьмой|девятый|десятый)(?![\p{L}\p{N}]))?|(?<=[.!?…])\s+(?=\p{Lu})/gu; // shippable-allow: the spoken command words of Russian

// The speech model follows the profile's language, Russian for some users, so an English word may also come back in Cyrillic letters.
const ITEM_EN = /(?<![\p{L}\p{N}])(?:[Ii]tem|ITEM|[Аа]йтем|[Ии]тем)(?![\p{L}\p{N}])(?:\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?![\p{L}\p{N}]))?|(?<=[.!?…])\s+(?=\p{Lu})/gu; // shippable-allow: English words the Russian speech model spells in Cyrillic

export function splitItems(text: string, lang = 'ru'): string[] {
  return text.split(lang === 'en' ? ITEM_EN : ITEM_RU).flatMap((part) => {
    const clean = part.replace(/^[\s.,;:!?…-]+|[\s.,;:…-]+$/g, '');
    return clean ? [clean[0].toUpperCase() + clean.slice(1)] : [];
  });
}

// Each item on its own line. An empty item under the caret takes the first of them.
export function insertItems(value: string, start: number, end: number, items: string[]): { value: string; caret: number } {
  const after = value.slice(end);
  let before = value.slice(0, start);
  const current = parseItem(before.slice(before.lastIndexOf('\n') + 1));
  const fill = current?.text === '';
  const indent = current?.indent ?? '';
  if (fill) before = `${before.trimEnd()} `;
  else if (before && !before.endsWith('\n')) before += '\n';
  const body = items.map((item, i) => (fill && i === 0 ? item : `${indent}- [ ] ${item}`)).join('\n');
  const tail = after && !after.startsWith('\n') ? `\n${after}` : after;
  return { value: before + body + tail, caret: before.length + body.length };
}
