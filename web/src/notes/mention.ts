import type { DragEvent } from 'react';

// A file or a note becomes `@path` in a chat input: by dragging it there or by a click.
export const MENTION_MIME = 'application/x-claude-os-mention';
const TAG_EVENT = 'claude-os:tag';

// A hint rides after the path, on its own line of the payload, and goes into the chat next to the tag.
const mentionText = (payload: string) => {
  const [path, hint] = payload.split('\n');
  const tag = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  return hint ? `${tag} (${hint})` : tag;
};
const payloadOf = (path: string, hint?: string) => (hint ? `${path}\n${hint}` : path);

export const mentionFor = (path: string, hint?: string) => mentionText(payloadOf(path, hint));

export function dragMention(e: DragEvent, path: string, hint?: string) {
  e.dataTransfer.setData(MENTION_MIME, payloadOf(path, hint));
  e.dataTransfer.setData('text/plain', mentionText(payloadOf(path, hint)));
  e.dataTransfer.effectAllowed = 'copy';
}

/** False: no chat input on the screen took it. */
export function tagInChat(path: string, hint?: string): boolean {
  return !document.dispatchEvent(new CustomEvent(TAG_EVENT, { detail: payloadOf(path, hint), cancelable: true }));
}

export function onTag(handler: (e: CustomEvent<string>) => void): () => void {
  const listener = (e: Event) => handler(e as CustomEvent<string>);
  document.addEventListener(TAG_EVENT, listener);
  return () => document.removeEventListener(TAG_EVENT, listener);
}

/** Types into the box at its caret. insertText goes through the field's own input event: React state and undo both see it. */
export function insertMention(box: HTMLTextAreaElement, path: string) {
  const at = box.selectionStart;
  const gap = at > 0 && !/\s/.test(box.value[at - 1]) ? ' ' : '';
  box.focus();
  document.execCommand('insertText', false, `${gap}${mentionText(path)} `);
}
