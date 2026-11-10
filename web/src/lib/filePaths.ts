// Paths as Claude writes them in a reply or a tool's output.
const SEGMENT = String.raw`[\p{L}\p{N}_@.+-]+`;
const KNOWN = 'ts|tsx|js|jsx|mjs|cjs|json|md|py|php|go|rs|java|kt|rb|c|h|cpp|hpp|cs|css|scss|html|vue|svelte|yml|yaml|toml|ini|sh|sql|txt|xml|lock|log|csv|png|jpe?g|gif|webp|avif|bmp';

// A folder in front or a known extension: "and/or", "1/2" and "e.g." are not files. Not after a word or a slash: no part of a URL.
const PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./:@\\-])` +
    '(' +
    String.raw`[A-Za-z]:[\\/](?:${SEGMENT}[\\/])*${SEGMENT}\.[\p{L}\p{N}]{1,8}` + // C:\dir\a.ts: a server on Windows answers in these
    String.raw`|(?:~|\.{1,2})?/(?:${SEGMENT}/)*${SEGMENT}\.[\p{L}\p{N}]{1,8}` + // /abs/a.ts, ~/a.ts, ./a.ts, ../a.ts
    String.raw`|(?:${SEGMENT}/)+${SEGMENT}\.[\p{L}\p{N}]{1,8}` + // src/a.ts
    String.raw`|(?:${SEGMENT}/)+(?:Makefile|Dockerfile|LICENSE)` +
    String.raw`|${SEGMENT}\.(?:${KNOWN})` + // a.ts
    ')' +
    String.raw`(?::(\d+)(?::\d+)?)?(?![\p{L}\p{N}_/-])`,
  'gu',
);

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const WORD_JS = /^[A-Z][a-z]+\.js$/; // Node.js, Vue.js: names, not files

export interface FoundPath {
  index: number;
  length: number;
  path: string;
  line: number | null;
}

export function findPaths(text: string): FoundPath[] {
  const out: FoundPath[] = [];
  for (const m of text.matchAll(PATH)) {
    if (WORD_JS.test(m[1])) continue;
    out.push({ index: m.index, length: m[0].length, path: m[1], line: m[2] ? Number(m[2]) : null });
  }
  return out;
}

export const isImagePath = (path: string) => IMAGE.test(path);

/** How a full path reads in the chat: relative inside the tab's folder, else the home as `~` and only the tail of a long one. */
export function displayPath(full: string, cwd: string | null): string {
  const root = cwd?.replace(/\/+$/, '');
  if (root && full.startsWith(`${root}/`)) return full.slice(root.length + 1);
  if (!full.startsWith('/') && !full.startsWith('~/')) return full;
  const home = full.replace(/^\/home\/[^/]+(?=\/)/, '~');
  const parts = home.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : home;
}

export const imageUrl = (tabId: string, path: string) => `/api/tabs/${encodeURIComponent(tabId)}/image?path=${encodeURIComponent(path)}`;
