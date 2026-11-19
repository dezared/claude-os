// `/secret [NAME=]value` at the start of any line of the chat input: the field shows that line's value as dots, the server
// keeps it (server/chat/secrets.ts), and the conversation gets only a marker with the name. The functions here are pure, for both ends.
import type { Attachment } from './contract.ts';
import { SECRET_COMMAND } from './commands.ts';

// POST /api/tabs/:id/secret: the value goes here, never into a message. Either one value, or a whole message whose
// `/secret` lines the server stores and replaces by their markers before it goes out as one turn.
export interface SecretRequest { name?: string | null; value?: string; text?: string; attachments?: Attachment[]; }

export const SECRET_PREFIX = `/${SECRET_COMMAND} `;
export const SECRET_MASK = '•';
// Env style, so the name works as $NAME and as a key in .env.
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// A name only counts with its `=`: an uppercase first word alone (an AWS key, say) is the value itself.
const NAMED = /^([A-Z][A-Z0-9_]{0,63})=/;

/** What the conversation, and so Claude, gets instead of the value. No `]` inside: the chat finds it by SECRET_MARKER. */
export const secretMarker = (name: string) =>
  `[secret ${name} saved: its value is hidden from you and must never be printed; write_secret puts it into a project file, list_secrets names them all, and Bash has it as $${name} from the next session start]`;
export const SECRET_MARKER = /\[secret ([A-Z][A-Z0-9_]*) saved: [^\]]*\]/g;
// A /secret line: its value runs to the end of the line, the next line is plain text again.
const LINE = new RegExp(`^${SECRET_PREFIX}([^\\n]*)$`, 'gm');
const LINE_START = new RegExp(`^${SECRET_PREFIX}`, 'm');

/** Whether any line of the text is a /secret line. */
export const hasSecretLine = (text: string) => LINE_START.test(text);

/** Each /secret line of the text: where it is, and the name and value typed on it. */
export const secretLines = (text: string) =>
  [...text.matchAll(LINE)].map((m) => ({ start: m.index, end: m.index + m[0].length, ...splitSecret(m[1]) }));

/** The name, if one was typed, and the value after `/secret `. */
export function splitSecret(rest: string): { name: string | null; value: string } {
  const named = NAMED.exec(rest);
  return named ? { name: named[1], value: rest.slice(named[0].length).trim() } : { name: null, value: rest.trim() };
}

/** The field's text as it is shown: on each /secret line a typed `NAME=` stays readable, every other character after it is a dot. */
export function maskField(raw: string): string {
  return raw.replace(LINE, (_line, rest: string) => {
    const name = NAMED.exec(rest)?.[0] ?? '';
    return SECRET_PREFIX + name + SECRET_MASK.repeat(rest.length - name.length);
  });
}

// A multi-line text put into a secret's value: its first line would join the value, the others would show as plain text.
function splitsValue(next: string, at: number, inserted: string): boolean {
  const cut = inserted.indexOf('\n');
  if (cut < 0 || !inserted.slice(cut).trim()) return false; // a line break alone just ends the value
  const end = at + cut;
  const start = next.lastIndexOf('\n', end - 1) + 1;
  return next.startsWith(SECRET_PREFIX, start) && end > start + SECRET_PREFIX.length;
}

/**
 * The real text after an edit of the shown one, or null when the edit is refused. Shown and real have the same length,
 * so the edit, found from the caret (everything after it is unchanged), lands at the same place in the real text.
 * A hidden character the edit would show (a broken `/secret ` prefix, a value cut by a line break) stays a dot, and a
 * multi-line paste into a value is refused: the hidden value must not come back as plain text.
 */
export function editField(raw: string, shownBefore: string, shownAfter: string, caret: number): string | null {
  // No dots shown, nothing hidden: the field's text is the real one. The caret is no guide here: an undo leaves it before the text it restores.
  if (maskField(raw) === raw) return shownAfter;
  const kept = shownAfter.length - caret;
  const limit = Math.max(0, Math.min(caret, shownBefore.length - kept));
  let same = 0;
  while (same < limit && shownBefore[same] === shownAfter[same]) same++;
  const tail = shownBefore.length - kept;
  const inserted = shownAfter.slice(same, caret);
  const next = raw.slice(0, same) + inserted + raw.slice(tail);
  if (splitsValue(next, same, inserted)) return null;
  // Still after a `/secret ` prefix: a typed `=` may turn the start into a readable name, nothing else shows.
  const lines = secretLines(next);
  const covered = (j: number) => lines.some((l) => j >= l.start + SECRET_PREFIX.length && j < l.end);
  const from = (j: number) => (j < same ? j : j >= caret ? j - caret + tail : -1); // its place in the real text; -1 for a typed one
  return next.split('').map((ch, j) => {
    const i = from(j);
    return i >= 0 && shownBefore[i] !== raw[i] && !covered(j) ? shownBefore[i] : ch;
  }).join('');
}
