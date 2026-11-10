import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Violation = { path: string; line: number; rule: 'cyrillic' | 'home-path' | 'private-word'; excerpt: string };

// Files where Cyrillic is expected: the ru catalog, tests, plugin UIs and plugin end-to-end tools.
export const CYRILLIC_ALLOW: string[] = [
  'web/src/lib/locales/ru.ts',
  '**/*.test.ts',
  'e2e/**',
  'server/**/fixtures/**',
  'plugins/*/ui/**',
  'plugins/*/tools/e2e.mjs',
];

// Placeholder home folders in tests and fixtures. The owner's own folder and the private-word rule still apply there.
export const HOME_PATH_ALLOW: string[] = ['**/*.test.ts', 'e2e/**', 'server/**/fixtures/**'];

const CYRILLIC = /\p{Script=Cyrillic}/u;
// Absolute only: `src/home/`, `@/home/` and `./home/` are folders inside the repo.
const HOME_PATHS = [
  /(?<![\w.@~-])\/home\/[\w.-]+/,
  /(?<![\w.@~-])\/Users\/[\w.-]+/,
  /(?:[A-Za-z]:|\/mnt\/[a-z])(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[\w.-]+/i,
];
const OWNER_PATH = /_projects\/_self/;
const PLUGIN_MANIFEST = 'plugins/*/plugin.json';
const LOCALIZED_KEY = /^\s*"[^"]*Ru"\s*:/;
const LOCALIZED_LIST = /^\s*"[^"]*Ru"\s*:\s*\[\s*$/;
// The frontmatter of a microtask or a knowledge file carries its Russian texts as `*_ru:` keys, like the `*Ru` keys of a manifest.
const LOCALIZED_FRONTMATTER = ['root/microtasks/*.md', 'root/document-knowledge/*.md'];
const FRONTMATTER_LOCALIZED_KEY = /^\w+_ru:/;
// Trailing `// shippable-allow: <reason>` or `# shippable-allow: <reason>`; skips the Cyrillic rule only.
const ALLOW_MARKER = /(?:\/\/|#)\s*shippable-allow: \S.*$/;

export function findViolations(files: { path: string; text: string }[], privateWords: string[]): Violation[] {
  // Whole words only: a short name like "Ann" must not flag "annotation". A letter or a digit of any script continues a word.
  const words = privateWords.map((w) => w.trim()).filter(Boolean).map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu'));
  const violations: Violation[] = [];
  for (const { path, text } of files) {
    const cyrillicAllowed = CYRILLIC_ALLOW.some((glob) => matchesGlob(path, glob));
    const homePathAllowed = HOME_PATH_ALLOW.some((glob) => matchesGlob(path, glob));
    const manifest = matchesGlob(path, PLUGIN_MANIFEST);
    const localizedFrontmatter = LOCALIZED_FRONTMATTER.some((glob) => matchesGlob(path, glob));
    let inLocalizedList = false; // the items of a "...Ru": [ ... ] list spread over lines
    let frontmatterEnd = -1; // the line closing a leading `---` block
    if (localizedFrontmatter && text.startsWith('---\n')) frontmatterEnd = text.split('\n').indexOf('---', 1);
    text.split('\n').forEach((raw, i) => {
      const add = (rule: Violation['rule']) => violations.push({ path, line: i + 1, rule, excerpt: raw.trim().slice(0, 120) });
      if (manifest && LOCALIZED_LIST.test(raw)) inLocalizedList = true;
      else if (inLocalizedList && /^\s*\]/.test(raw)) inLocalizedList = false;
      const allowedLine = (manifest && (inLocalizedList || LOCALIZED_KEY.test(raw))) || (i < frontmatterEnd && FRONTMATTER_LOCALIZED_KEY.test(raw)) || ALLOW_MARKER.test(raw);
      if (!cyrillicAllowed && !allowedLine && CYRILLIC.test(raw)) add('cyrillic');
      if ((!homePathAllowed && HOME_PATHS.some((re) => re.test(raw))) || OWNER_PATH.test(raw)) add('home-path');
      if (words.some((re) => re.test(raw))) add('private-word');
    });
  }
  return violations;
}

function main() {
  const wordsFile = process.env.CLAUDE_OS_PRIVATE_WORDS || 'config/private-words.txt';
  const words = existsSync(wordsFile) ? readFileSync(wordsFile, 'utf8').split('\n') : [];
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && existsSync(path))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => !text.includes('\0'));
  const violations = findViolations(files, words);
  for (const v of violations) console.log(`${v.path}:${v.line} [${v.rule}] ${v.excerpt}`);
  if (violations.length) {
    console.error(`check:shippable: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('check:shippable: clean');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
