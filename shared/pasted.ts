// A long paste goes out of the chat input wrapped in this tag (web/src/work/pastes.ts): the chat folds it, Claude reads it as one block.
export const PASTED_BLOCK = /<pasted lines="\d+">\n([\s\S]*?)\n<\/pasted>/g;

/** The text without the tags, for one-line places: a queue row, a session title. A tag cut off by a clip goes too. */
export const stripPastedTags = (text: string) => text.replace(/<pasted lines="\d+">\n?|\n?<\/pasted>/g, '');

/** An edit of the stripped text back into the stored one: a pasted block whose text is still there, in order, keeps its tags
 * and so its folding; a block the edit touched stays as plain text. */
export function keepPastedTags(original: string, edited: string): string {
  let out = edited;
  let from = 0;
  for (const [block, inner] of original.matchAll(PASTED_BLOCK)) {
    const at = out.indexOf(inner, from);
    if (at < 0) continue;
    out = out.slice(0, at) + block + out.slice(at + inner.length);
    from = at + block.length;
  }
  return out;
}
