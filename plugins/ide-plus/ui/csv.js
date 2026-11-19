// CSV and TSV for the table view. Each row keeps the exact text it was read from, so a save rewrites only the rows that changed.
const QUOTE = '"';

const plainEnd = (text, at, sep) => {
  let end = at;
  while (end < text.length && text[end] !== sep && text[end] !== '\n' && text[end] !== '\r') end++;
  return end;
};

function readField(text, at, sep) {
  if (text[at] !== QUOTE) {
    const end = plainEnd(text, at, sep);
    return { value: text.slice(at, end), quoted: false, next: end };
  }
  let value = '';
  let i = at + 1;
  for (;;) {
    const close = text.indexOf(QUOTE, i);
    if (close < 0) return { value: value + text.slice(i), quoted: true, next: text.length };
    value += text.slice(i, close);
    if (text[close + 1] !== QUOTE) {
      // Text after the closing quote stays part of the cell, as spreadsheets read it.
      const end = plainEnd(text, close + 1, sep);
      return { value: value + text.slice(close + 1, end), quoted: true, next: end };
    }
    value += QUOTE;
    i = close + 2;
  }
}

const terminator = (text, at) => {
  if (text[at] === '\r' && text[at + 1] === '\n') return '\r\n';
  return text[at] === '\n' || text[at] === '\r' ? text[at] : '';
};

/** Rows of `{ cells, quoted, raw, end, source }`: `raw` and `end` are the row's own text and line ending, `source` its cells as read. */
export function parseCsv(text, sep) {
  const rows = [];
  let at = 0;
  while (at < text.length) {
    const start = at;
    const cells = [];
    const quoted = [];
    for (;;) {
      const field = readField(text, at, sep);
      cells.push(field.value);
      quoted.push(field.quoted);
      at = field.next;
      if (text[at] !== sep) break;
      at++;
    }
    const end = terminator(text, at);
    rows.push({ cells, quoted, raw: text.slice(start, at), end, source: cells });
    at += end.length;
  }
  return rows;
}

const same = (a, b) => a.length === b.length && a.every((cell, i) => cell === b[i]);
const needsQuotes = (cell, sep) => cell.includes(sep) || /["\r\n]/.test(cell);
const quote = (cell) => `${QUOTE}${cell.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`;

/** A changed row is written anew, quoting a cell that was quoted before or needs it now; any other row is its text as read. */
export function serializeCsv(rows, sep) {
  return rows.map((row) => {
    if (same(row.cells, row.source)) return row.raw + row.end;
    return row.cells.map((cell, i) => (row.quoted[i] || needsQuotes(cell, sep) ? quote(cell) : cell)).join(sep) + row.end;
  }).join('');
}

/** The rows with one cell replaced; a cell past the end of a short row lengthens it. */
export function withCell(rows, r, c, value) {
  return rows.map((row, i) => {
    if (i !== r) return row;
    const cells = [...row.cells];
    while (cells.length < c) cells.push('');
    cells[c] = value;
    return { ...row, cells };
  });
}

/** A .csv from a European spreadsheet is often separated by semicolons: the first line decides. */
export function separatorFor(ext, text) {
  if (ext === 'tsv') return '\t';
  const first = text.slice(0, plainEnd(text, 0, ''));
  const count = (ch) => first.split(ch).length - 1;
  return count(';') > count(',') ? ';' : ',';
}
