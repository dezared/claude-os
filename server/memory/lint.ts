import { basename } from 'node:path';
import { isMap, parseNote, serializeFrontmatter, type FmMap, type FmValue, type Frontmatter } from './frontmatter.ts';
import { extractLinks, normalizeName } from './wikilinks.ts';

// The one source of the note format limits: NOTE_RULES.md, the hook, the watcher and the migration follow these.
export const LINT_LIMITS = {
  name: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  nameMax: 60,
  genericNames: ['project', 'state', 'decisions', 'feedback', 'notes', 'misc', 'todo'],
  descriptionMax: 120,
  types: ['user', 'feedback', 'project', 'reference'],
  tagsMin: 1,
  tagsMax: 3,
  bodySoft: 1500,
  bodyMax: 3000,
  nonLatinMax: 0.15,
} as const;

export interface LintCtx {
  path: string;
  project: string | null;
  // normalizeName -> vault paths of the notes with that name
  names: Map<string, string[]>;
  // the project's tags, most used first
  tags: string[];
  resolves(name: string): boolean;
}

export interface Issue {
  code: string;
  message: string;
  reject: boolean;
}

export interface LintResult {
  fixed: string | null;
  fixes: string[];
  issues: Issue[];
}

export function slugOf(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[_\s]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const TOP = ['name', 'description', 'metadata'];
const chars = (s: string) => [...s].length;
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// Quotes of the user and code may stay in their language.
function nonLatinRatio(text: string): number {
  const prose = text
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/"[^"\n]*"|«[^»\n]*»|“[^”\n]*”/g, '');
  const letters = prose.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length / letters.length;
}

// The issues of one note, in check order.
interface Collector {
  issues: Issue[];
  reject(code: string, message: string): void;
  flag(code: string, message: string): void;
}

function collector(): Collector {
  const issues: Issue[] = [];
  return {
    issues,
    reject: (code, message) => void issues.push({ code, message, reject: true }),
    flag: (code, message) => void issues.push({ code, message, reject: false }),
  };
}

const L = LINT_LIMITS;

// LF line ends, no trailing blanks; but two or more spaces before the next line of a body paragraph stay:
// that is a markdown hard line break.
function normalizeWhitespace(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const strip = (line: string) => line.replace(/[ \t]+$/, '');
  const fmEnd = strip(lines[0]) === '---' ? lines.findIndex((l, i) => i > 0 && strip(l) === '---') : -1;
  const hardBreak = (line: string, i: number) => i > fmEnd && /\S {2,}$/.test(line) && /\S/.test(lines[i + 1] ?? '');
  return lines.map((l, i) => (hardBreak(l, i) ? l : strip(l))).join('\n');
}

// The fixes below change `fm` in place and name themselves in `fixes`.
function fixName(fm: Frontmatter, stem: string, fixes: string[]): void {
  const slug = slugOf(stem);
  if (slug && fm.name !== slug) {
    fm.name = slug;
    fixes.push('name-mismatch');
  }
}

// Claude Code re-emits only name, description and metadata: anything else would be lost.
function moveTopLevelKeys(fm: Frontmatter, fixes: string[]): void {
  const movable = Object.keys(fm).filter((k) => !TOP.includes(k) && !isMap(fm[k]));
  if (!movable.length || (fm.metadata !== undefined && !isMap(fm.metadata))) return;
  const meta: FmMap = fm.metadata ?? {};
  const moved = movable.filter((k) => !(k in meta));
  for (const k of moved) {
    meta[k] = fm[k] as string | string[];
    delete fm[k];
  }
  if (moved.length) {
    fm.metadata = meta;
    fixes.push('old-type');
  }
}

// The tags as a list of unique slugs; [] when there are none.
function normalizeTags(meta: FmMap, fixes: string[]): string[] {
  const raw = meta.tags;
  if (typeof raw !== 'string' && !Array.isArray(raw)) return [];
  const norm = [...new Set((typeof raw === 'string' ? raw.split(',') : raw).map(slugOf).filter(Boolean))];
  if (typeof raw === 'string' || !sameList(norm, raw)) {
    meta.tags = norm;
    fixes.push('tags-format');
  }
  return norm;
}

function checkName(name: string, ctx: LintCtx, c: Collector): void {
  if ((L.genericNames as readonly string[]).includes(name)) {
    c.reject('name-generic', `name "${name}" is generic; write the note to a file named after its fact, e.g. ${name}-<topic>.md`);
  }
  const others = (ctx.names.get(normalizeName(name)) ?? []).filter((p) => p !== ctx.path);
  if (others.length) c.reject('name-duplicate', `name "${name}" is taken by ${others[0]}; update that note or choose another file name`);
  if (chars(name) > L.nameMax) c.reject('name-long', `name is ${chars(name)} chars; max ${L.nameMax}: use a shorter file name`);
}

// Returns the description for the language check.
function checkDescription(fm: Frontmatter, c: Collector): string | null {
  const description = typeof fm.description === 'string' ? fm.description : null;
  if (!description?.trim()) {
    c.reject('no-description', `description is missing; add one line, max ${L.descriptionMax} chars, with the question the note answers`);
    return description;
  }
  const lines = description.split('\n').length;
  if (lines > 1) c.reject('description-multiline', `description has ${lines} lines; max 1: write it as one line`);
  if (chars(description) > L.descriptionMax) {
    c.reject('description-long', `description is ${chars(description)} chars; max ${L.descriptionMax}: shorten it to the question the note answers`);
  }
  return description;
}

function checkTypeAndTags(meta: FmMap, tags: string[], ctx: LintCtx, c: Collector): void {
  const type: FmValue | undefined = meta.type;
  if (typeof type !== 'string' || !(L.types as readonly string[]).includes(type)) {
    const shown = typeof type === 'string' ? `"${type}"` : 'missing';
    c.reject('bad-type', `metadata.type is ${shown}; set it to one of ${L.types.join(', ')}`);
  }
  if (tags.length < L.tagsMin || tags.length > L.tagsMax) {
    const project = ctx.project ?? 'global';
    const known = ctx.tags.length ? `existing tags in ${project}: ${ctx.tags.slice(0, 20).join(', ')}` : `no tags in ${project} yet`;
    c.reject('tags-count', `metadata.tags has ${tags.length}; use ${L.tagsMin}-${L.tagsMax} lowercase kebab tags, reuse existing ones; ${known}`);
  }
}

// `clean` is the whole note: a link in the frontmatter counts too.
function checkBody(note: { clean: string; body: string; description: string | null }, ctx: LintCtx, c: Collector): void {
  const size = chars(note.body.trim());
  if (size > L.bodyMax) c.reject('body-long', `body is ${size} chars; max ${L.bodyMax}: split it into notes, one fact each`);
  else if (size > L.bodySoft) c.flag('body-soft', `body is ${size} chars; aim for ${L.bodySoft}: keep one fact, move the rest to another note`);

  const ratio = nonLatinRatio(`${note.description ?? ''}\n${note.body}`);
  if (ratio > L.nonLatinMax) {
    c.reject('not-english', `text is ${Math.round(ratio * 100)}% non-Latin letters; write the note in English, a short quote of the user may stay in quotes`);
  }

  const missing = extractLinks(note.clean).filter((n) => !ctx.resolves(n));
  if (missing.length) {
    c.flag('link-unresolved', `${missing.map((n) => `[[${n}]]`).join(', ')} resolve to no note; link an existing note name or remove the link`);
  }
}

export function lintNote(file: string, markdown: string, ctx: LintCtx): LintResult {
  const c = collector();
  const clean = normalizeWhitespace(markdown);
  const fixes = clean !== markdown ? ['whitespace'] : [];
  const { fm, body } = parseNote(clean);
  let fixed = clean;
  let description: string | null = null;
  if (!fm) {
    c.reject('no-frontmatter', 'note has no frontmatter; start it with --- name, description, metadata (type, tags) --- as NOTE_RULES.md shows');
  } else {
    const stem = basename(file).replace(/\.md$/i, '');
    fixName(fm, stem, fixes);
    moveTopLevelKeys(fm, fixes);
    const meta: FmMap = isMap(fm.metadata) ? fm.metadata : {};
    const tags = normalizeTags(meta, fixes);
    if (fixes.some((f) => f !== 'whitespace')) fixed = serializeFrontmatter(fm) + body;
    checkName(typeof fm.name === 'string' ? fm.name : stem, ctx, c);
    description = checkDescription(fm, c);
    checkTypeAndTags(meta, tags, ctx, c);
  }
  checkBody({ clean, body, description }, ctx, c);
  return { fixed: fixed === markdown ? null : fixed, fixes, issues: c.issues };
}
