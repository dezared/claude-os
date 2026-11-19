// An xlsx or ods workbook as plain text cells, for a read-only table. Both are zipped XML: no library, and the bytes decide which.
import type { ProjectSheet } from '../../shared/files.ts';
import { httpError } from '../memory/util.ts';
import { zipEntries } from './zipEntries.ts';

export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEET_COLS = 200;
export const MAX_SHEETS = 100;
export const MAX_CELL_TEXT = 32 * 1024;
// The whole answer: 5000 rows of 200 long cells would be gigabytes of JSON.
export const MAX_SHEET_TEXT = 16 * 1024 * 1024;

type Sheet = ProjectSheet['sheets'][number];
type Entries = Map<string, () => Buffer>;
type Budget = { left: number };

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
  if (e[0] !== '#') return ENTITIES[e] ?? all;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code <= 0x10ffff ? String.fromCodePoint(code) : all;
});
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};
const xml = (entries: Entries, name: string) => entries.get(name)?.().toString('utf8') ?? null;

/**
 * Each `<name …>body</name>` or `<name …/>` in order, for any of the `|`-separated names. Found with indexOf, not a lazy
 * regex: an unclosed tag costs one scan to the end, not one per tag after it.
 */
function* elements(source: string, names: string): Generator<{ name: string; head: string; body: string }> {
  const open = new RegExp(`<(${names})(?=[\\s>/])`, 'g');
  const unclosed = new Set<string>();
  for (let m = open.exec(source); m; m = open.exec(source)) {
    const name = m[1];
    const gt = source.indexOf('>', open.lastIndex);
    if (gt < 0) return;
    const head = source.slice(open.lastIndex, gt);
    open.lastIndex = gt + 1;
    if (head.endsWith('/')) {
      yield { name, head: head.slice(0, -1), body: '' };
      continue;
    }
    const close = unclosed.has(name) ? -1 : source.indexOf(`</${name}>`, gt);
    if (close < 0) {
      unclosed.add(name);
      continue;
    }
    yield { name, head, body: source.slice(gt + 1, close) };
    open.lastIndex = close + name.length + 3;
  }
}
const first = (source: string, name: string) => {
  for (const e of elements(source, name)) return e.body;
  return undefined;
};

// Charges rows against the whole answer: once it runs out, the rest of the workbook is cut.
function fits(cells: string[], times: number, budget: Budget): boolean {
  const size = cells.reduce((n, c) => n + c.length, 0) * times;
  if (size > budget.left) {
    budget.left = 0;
    return false;
  }
  budget.left -= size;
  return true;
}

/** Drops empty rows and cells at the end, and marks a sheet cut when a row or column with text did not fit. */
function finish(name: string, rows: string[][], cut: boolean): Sheet {
  for (const row of rows) while (row.length && row[row.length - 1] === '') row.pop();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return { name, rows, truncated: cut };
}

// ---------- xlsx ----------

const columnOf = (ref: string) => [...(/^[A-Z]*/.exec(ref)?.[0] ?? '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
// The text runs of a string; a phonetic hint (rPh) holds runs of its own, skipped with it.
const runs = (body: string) => [...elements(body, 'rPh|t')].filter((e) => e.name === 't').map((e) => decode(e.body)).join('');

function cellText(head: string, body: string, shared: string[]): string {
  const value = first(body, 'v');
  const type = attr(head, 't');
  if (type === 'inlineStr') return runs(body);
  if (value === undefined) return '';
  if (type === 's') return shared[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return decode(value);
}

function xlsxRow(body: string, shared: string[]): { cells: string[]; cut: boolean } {
  const cells: string[] = [];
  let cut = false;
  for (const c of elements(body, 'c')) {
    const ref = attr(c.head, 'r');
    const col = ref ? columnOf(ref) : cells.length;
    const text = cellText(c.head, c.body, shared);
    if (col >= MAX_SHEET_COLS) {
      cut ||= text !== '';
      continue;
    }
    while (cells.length < col) cells.push('');
    cells[col] = text.slice(0, MAX_CELL_TEXT);
    cut ||= text.length > MAX_CELL_TEXT;
  }
  return { cells, cut };
}

function xlsxSheet(name: string, source: string, shared: string[], budget: Budget): Sheet {
  const rows: string[][] = [];
  let cut = false;
  for (const r of elements(source, 'row')) {
    const index = Number(attr(r.head, 'r') ?? rows.length + 1) - 1;
    const row = xlsxRow(r.body, shared);
    if (index >= MAX_SHEET_ROWS || !fits(row.cells, 1, budget)) {
      cut ||= row.cells.some(Boolean);
      continue;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = row.cells;
    cut ||= row.cut;
  }
  return finish(name, rows, cut);
}

function readXlsx(entries: Entries, budget: Budget): ProjectSheet {
  const shared = [...elements(xml(entries, 'xl/sharedStrings.xml') ?? '', 'si')].map((si) => runs(si.body));
  const targets = new Map<string, string>();
  for (const { head } of elements(xml(entries, 'xl/_rels/workbook.xml.rels') ?? '', 'Relationship')) {
    const target = attr(head, 'Target') ?? '';
    targets.set(attr(head, 'Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [...elements(xml(entries, 'xl/workbook.xml') ?? '', 'sheet')].slice(0, MAX_SHEETS).map(({ head }) => {
    const source = xml(entries, targets.get(attr(head, 'r:id') ?? '') ?? '') ?? '';
    return xlsxSheet(attr(head, 'name') ?? '', source, shared, budget);
  });
  return { sheets };
}

// ---------- ods ----------

const INLINE: Record<string, string> = { 'text:tab': '\t', 'text:line-break': '\n' };

// A tag inside a paragraph: a run of spaces, a tab and a line break are text; the rest only wraps text.
function inlineTag(tag: string): string {
  const name = tag.split(/[\s/]/, 1)[0];
  if (name !== 'text:s') return INLINE[name] ?? '';
  return ' '.repeat(Math.min(Math.max(Number(attr(tag, 'text:c') ?? 1) || 0, 0), MAX_CELL_TEXT));
}

function paragraph(body: string): string {
  let out = '';
  let at = 0;
  while (at < body.length && out.length <= MAX_CELL_TEXT) {
    const lt = body.indexOf('<', at);
    const gt = lt < 0 ? -1 : body.indexOf('>', lt);
    if (gt < 0) return out + decode(body.slice(at));
    out += decode(body.slice(at, lt)) + inlineTag(body.slice(lt + 1, gt));
    at = gt + 1;
  }
  return out;
}

// Paragraphs only until the cell is over its cap: a short file can spell out runs of spaces far longer than itself.
function odsText(body: string): string {
  const lines: string[] = [];
  let size = 0;
  for (const p of elements(body, 'text:p')) {
    if (size > MAX_CELL_TEXT) break;
    lines.push(paragraph(p.body));
    size += lines[lines.length - 1].length + 1;
  }
  return lines.join('\n');
}

// A sheet ends in a cell or a row repeated to the edge of the format: only as many as fit are spelled out.
function odsRow(body: string): { cells: string[]; cut: boolean } {
  const cells: string[] = [];
  let cut = false;
  for (const c of elements(body, 'table:table-cell|table:covered-table-cell')) {
    const text = odsText(c.body);
    const repeat = Number(attr(c.head, 'table:number-columns-repeated') ?? 1);
    const room = Math.min(repeat, MAX_SHEET_COLS - cells.length);
    cut ||= (room < repeat && text !== '') || text.length > MAX_CELL_TEXT;
    for (let i = 0; i < room; i++) cells.push(text.slice(0, MAX_CELL_TEXT));
  }
  return { cells, cut };
}

function odsSheet(head: string, body: string, budget: Budget): Sheet {
  const rows: string[][] = [];
  let cut = false;
  for (const r of elements(body, 'table:table-row')) {
    const row = odsRow(r.body);
    const repeat = Number(attr(r.head, 'table:number-rows-repeated') ?? 1);
    const empty = !row.cells.some(Boolean);
    const room = Math.min(repeat, MAX_SHEET_ROWS - rows.length);
    if (!fits(row.cells, room, budget)) {
      cut = true;
      continue;
    }
    cut ||= (room < repeat && !empty) || row.cut;
    for (let i = 0; i < room; i++) rows.push(empty ? [] : [...row.cells]);
  }
  return finish(attr(head, 'table:name') ?? '', rows, cut);
}

function readOds(entries: Entries, budget: Budget): ProjectSheet {
  const content = xml(entries, 'content.xml') ?? '';
  return { sheets: [...elements(content, 'table:table')].slice(0, MAX_SHEETS).map((t) => odsSheet(t.head, t.body, budget)) };
}

/** Only an xlsx or an ods: an old binary xls, or any other zip, is refused with 415. */
export function readSheet(bytes: Buffer): ProjectSheet {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50) throw httpError(415, 'not an xlsx or ods spreadsheet');
  const entries = zipEntries(bytes);
  const budget = { left: MAX_SHEET_TEXT };
  if (entries.has('xl/workbook.xml')) return readXlsx(entries, budget);
  if (xml(entries, 'mimetype')?.trim() === 'application/vnd.oasis.opendocument.spreadsheet') return readOds(entries, budget);
  throw httpError(415, 'not an xlsx or ods spreadsheet');
}
