import { parseNote } from './frontmatter.ts';
import { lintNote, type LintCtx } from './lint.ts';
import { normalizeName } from './wikilinks.ts';

// One map.json entry per input note of a migration batch (spec §4 step 2). File names are relative to out/.
export interface MapEntry {
  old: string;
  new: string[];
  primary: string | null;
  dropped: { what: string; why: string }[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDroppedList = (v: unknown): v is MapEntry['dropped'] => Array.isArray(v) && v.every((d) => isStr(d?.what) && isStr(d?.why));

// One entry of map.json, or the error that names it.
function readEntry(raw: unknown, at: string): MapEntry | string {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (!isStr(e.old)) return `${at}: "old" must be the input file name`;
  if (!Array.isArray(e.new) || !e.new.every(isStr)) return `${at} (${e.old}): "new" must be an array of file names in out/`;
  const primary = e.primary ?? null;
  if (primary !== null && !isStr(primary)) return `${at} (${e.old}): "primary" must be a file name or null`;
  const dropped = e.dropped ?? [];
  if (!isDroppedList(dropped)) {
    return `${at} (${e.old}): "dropped" must be an array of { "what", "why" } with both filled in`;
  }
  return { old: e.old, new: e.new, primary, dropped: dropped.map((d) => ({ what: d.what, why: d.why })) };
}

export function readMap(text: string): { entries: MapEntry[]; error: string | null } {
  const fail = (error: string) => ({ entries: [], error });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return fail(`map.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) return fail('map.json must be an array of { "old", "new", "primary", "dropped" } entries');
  const entries: MapEntry[] = [];
  for (const [i, raw] of data.entries()) {
    const entry = readEntry(raw, `map.json entry ${i + 1}`);
    if (typeof entry === 'string') return fail(entry);
    entries.push(entry);
  }
  return { entries, error: null };
}

const URL_RE = /https?:\/\/[^\s<>()[\]{}`"']+/g;

// The facts a rewrite must not lose silently: code spans, URLs, paths and numbers of 2+ digits.
export function factTokens(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (m[1].trim()) found.add(m[1].trim());
  for (const m of text.matchAll(URL_RE)) found.add(m[0].replace(/[.,:;!?]+$/, ''));
  const rest = text.replace(URL_RE, ' ');
  for (const m of rest.matchAll(/[^\s`'"()<>[\]{},;*]+/g)) {
    const token = m[0].replace(/[.:!?]+$/, '');
    if (/\w\/\w/.test(token)) found.add(token);
  }
  for (const m of rest.matchAll(/\b\d{2,}\b/g)) found.add(m[0]);
  return [...found];
}

// `120` must not count as kept because `1200` is there.
function occurs(hay: string, token: string): boolean {
  const word = /\w/;
  for (let i = hay.indexOf(token); i >= 0; i = hay.indexOf(token, i + 1)) {
    const glued = (word.test(token[0]) && word.test(hay[i - 1] ?? '')) || (word.test(token.at(-1)!) && word.test(hay[i + token.length] ?? ''));
    if (!glued) return true;
  }
  return false;
}

interface Batch {
  inputs: { file: string; text: string }[];
  map: MapEntry[];
  out: Map<string, string>;
  lintCtx(file: string): LintCtx;
  taken: Set<string>;
}

type Found = { errors: string[]; warnings: string[] };

// One map.json entry per input, and nothing else.
function checkCoverage(a: Batch, found: Found): void {
  const inputs = new Set(a.inputs.map((i) => i.file));
  const count = new Map<string, number>();
  for (const e of a.map) {
    if (!inputs.has(e.old)) found.errors.push(`${e.old} is not an input of this batch; map.json lists only the input files`);
    count.set(e.old, (count.get(e.old) ?? 0) + 1);
  }
  for (const file of inputs) {
    const n = count.get(file) ?? 0;
    if (!n) found.errors.push(`${file} is missing from map.json; add one entry for it`);
    else if (n > 1) found.errors.push(`${file} is mapped ${n} times in map.json; keep one entry for it`);
  }
}

// Each entry's new notes exist, its primary is one of them, and an empty entry says what it dropped.
function checkEntries(a: Batch, found: Found): void {
  for (const e of a.map) {
    for (const f of e.new) {
      if (!a.out.has(f)) found.errors.push(`${f} is listed for ${e.old} but absent from out/; write it or remove it from "new"`);
    }
    if (e.new.length) {
      if (e.primary === null || !e.new.includes(e.primary)) {
        found.errors.push(`${e.old}: primary ${JSON.stringify(e.primary)} is not one of its new notes; set it to the note its old links should open`);
      }
      continue;
    }
    if (e.primary !== null) found.errors.push(`${e.old}: primary must be null when it has no new notes`);
    if (!e.dropped.length) found.errors.push(`${e.old} has no new notes and no dropped reason; write its notes or list what is dropped and why`);
  }
}

// Every out/ note is listed, passes lint, and takes a name free in the vault and in the batch.
function checkOutNotes(a: Batch, found: Found): void {
  const listed = new Set(a.map.flatMap((e) => e.new));
  const taken = new Set([...a.taken].map(normalizeName));
  const byName = new Map<string, string[]>();
  for (const [file, text] of a.out) {
    if (!listed.has(file)) {
      found.errors.push(`${file} is in out/ but no map.json entry lists it; list it under "new" or delete it`);
      continue;
    }
    const name = normalizeName(file);
    if (taken.has(name)) found.errors.push(`${file}: name "${name}" is taken in the vault; choose another file name or drop the duplicate fact`);
    byName.set(name, [...(byName.get(name) ?? []), file]);
    for (const issue of lintNote(file, text, a.lintCtx(file)).issues) (issue.reject ? found.errors : found.warnings).push(`${file}: ${issue.message}`);
  }
  for (const [name, files] of byName) {
    if (files.length > 1) found.errors.push(`${files.join(', ')}: same name "${name}" twice in the batch; merge them or rename one`);
  }
}

// The facts of an input that no new note and no dropped item keeps are warnings.
function checkFacts(a: Batch, found: Found): void {
  for (const input of a.inputs) {
    const entries = a.map.filter((e) => e.old === input.file);
    if (entries.length !== 1) continue;
    const e = entries[0];
    const hay = [...e.new.map((f) => a.out.get(f) ?? ''), ...e.dropped.map((d) => d.what)].join('\n');
    // Frontmatter stamps (session ids, dates) are not facts; the description may hold some.
    const { fm, body } = parseNote(input.text);
    const description = typeof fm?.description === 'string' ? fm.description : '';
    const missing = factTokens(`${description}\n${body}`).filter((t) => !occurs(hay, t));
    if (missing.length) found.warnings.push(`${input.file}: ${missing.map((t) => `\`${t}\``).join(', ')} kept in no new note and no dropped item`);
  }
}

export function verifyBatch(a: Batch): Found {
  const found: Found = { errors: [], warnings: [] };
  for (const check of [checkCoverage, checkEntries, checkOutNotes, checkFacts]) check(a, found);
  return found;
}

// Code first so links inside fences and spans are skipped, as extractLinks does.
const CODE_OR_LINK = /(^(```|~~~)[\s\S]*?^\2.*$|`[^`\n]*`)|\[\[([^\]\n|#]+)([#|][^\]\n]*)?\]\]/gm;

// `renames`: normalizeName(old) -> new note name.
export function rewriteLinks(text: string, renames: Map<string, string>): string {
  return text.replace(CODE_OR_LINK, (m, ...groups: (string | undefined)[]) => {
    const [code, , target, rest] = groups;
    if (code !== undefined || target === undefined) return m;
    const to = renames.get(normalizeName(target));
    return to === undefined ? m : `[[${to}${rest ?? ''}]]`;
  });
}
