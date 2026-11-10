// A long paste stays out of the field as in the terminal Claude: the field holds a short mark, the text goes out on send.
// Kept beside the draft, so a reload or a separate window of the same chat still has it.
import { t } from '@/lib/i18n';

export const PASTE_THRESHOLD = 800; // characters, the same as the terminal Claude
const PASTE_KEY = 'claude-os.pastes.';
const memory = new Map<string, Record<string, string>>(); // over the storage quota the text still lives here

function readPastes(id: string): Record<string, string> {
  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PASTE_KEY + id) ?? '{}') as Record<string, string>;
  } catch {
    // Damaged: the marks stay as plain words, nothing else can break.
  }
  return { ...saved, ...memory.get(id) };
}

function writePastes(id: string, pastes: Record<string, string>) {
  memory.set(id, pastes);
  try {
    if (Object.keys(pastes).length > 0) localStorage.setItem(PASTE_KEY + id, JSON.stringify(pastes));
    else localStorage.removeItem(PASTE_KEY + id);
  } catch {
    // Over the quota: this window keeps it in memory until the message goes out.
  }
}

/** Stores the text and returns the mark that stands for it in the field. */
export function addPaste(id: string, pasted: string): string {
  const text = pasted.replace(/\r\n?/g, '\n'); // a native paste into a textarea does the same
  const pastes = readPastes(id);
  const numbers = Object.keys(pastes).map((mark) => Number(/#(\d+)/.exec(mark)?.[1] ?? 0));
  const n = Math.max(0, ...numbers) + 1;
  const lines = text.split('\n').length;
  const mark = lines > 1 ? t('composer.pastedLines', { n, count: lines }) : t('composer.pastedChars', { n, count: text.length });
  writePastes(id, { ...pastes, [mark]: text });
  return mark;
}

/** The text a mark stands for, if it is still kept. */
export function pasteText(id: string, mark: string): string | undefined {
  return readPastes(id)[mark];
}

// A mark as the current language writes it: the number is the chip's id.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markSource = (key: 'composer.pastedLines' | 'composer.pastedChars') => escape(t(key, { n: '\u0001', count: '\u0002' })).replace('\u0001', '(\\d+)').replace('\u0002', '\\d+');
export const pastePattern = () => new RegExp(`${markSource('composer.pastedLines')}|${markSource('composer.pastedChars')}`, 'g');

/**
 * The field's text with every mark replaced by what it stands for, in a tag the chat folds and Claude reads as one block.
 * A mark the user erased just sends nothing.
 */
export function expandPastes(id: string, text: string): string {
  return Object.entries(readPastes(id)).reduce((out, [mark, full]) => out.replaceAll(mark, () => `<pasted lines="${full.split('\n').length}">\n${full}\n</pasted>`), text);
}

/** Forgets what the remaining text no longer refers to. */
export function prunePastes(id: string, remaining: string) {
  const pastes = readPastes(id);
  const kept = Object.fromEntries(Object.entries(pastes).filter(([mark]) => remaining.includes(mark)));
  if (Object.keys(kept).length !== Object.keys(pastes).length) writePastes(id, kept);
}
