// A checklist item is a plain markdown line, so a note stays readable as a file. The server and the panel read it the same way.
const ITEM = /^(\s*)- \[([ xX])\](?: +(.*?))?\s*$/;

export function parseItem(line: string): { indent: string; done: boolean; text: string } | null {
  const m = ITEM.exec(line);
  return m ? { indent: m[1], done: m[2] !== ' ', text: m[3] ?? '' } : null;
}
