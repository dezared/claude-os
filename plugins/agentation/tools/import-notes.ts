// Sends notes left in a browser to the agentation server once, under the Claude OS page's session, when the toolbar could
// not: node plugins/agentation/tools/import-notes.ts <notes.json> [--endpoint http://127.0.0.1:4747] [--url http://127.0.0.1:47821/]
// The file is the JSON array the toolbar keeps under the `feedback-annotations-/` key. Running it again adds nothing.
import { readFileSync } from 'node:fs';
import { importNotes, type LocalNote } from '../server/importNotes.ts';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const file = process.argv[2];
if (!file || file.startsWith('--')) throw new Error('usage: import-notes.ts <notes.json> [--endpoint <agentation server>] [--url <page>]');
const notes = JSON.parse(readFileSync(file, 'utf8')) as LocalNote[];
const result = await importNotes(arg('--endpoint', 'http://127.0.0.1:4747'), arg('--url', 'http://127.0.0.1:47821/'), notes);
process.stdout.write(`${JSON.stringify(result)}\n`);
