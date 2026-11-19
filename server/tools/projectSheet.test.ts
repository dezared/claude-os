import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { XLSX, zip } from './fixtures/workbooks.ts';
import { MAX_CELL_TEXT, MAX_SHEET_COLS, MAX_SHEET_ROWS, MAX_SHEET_TEXT, MAX_SHEETS, readSheet } from './projectSheet.ts';
import { MAX_UNPACKED_BYTES } from './zipEntries.ts';

describe('readSheet', () => {
  it('reads an xlsx: shared and inline strings, gaps, formulas by their value, booleans, sheet names', () => {
    const book = readSheet(zip(XLSX));
    assert.deepEqual(book.sheets, [
      { name: 'Люди & цифры', rows: [['Name', '', '<inline>'], [], ['Anna B', '2', 'TRUE']], truncated: false },
      { name: 'Empty', rows: [], truncated: false },
    ]);
  });

  it('reads an ods: repeated cells and rows, spaces, and the format-wide empty tail', () => {
    const content = '<office:document-content><office:body><office:spreadsheet>'
      + '<table:table table:name="Лист1"><table:table-column table:number-columns-repeated="3"/>'
      + '<table:table-row><table:table-cell office:value-type="string"><text:p>a<text:s text:c="2"/>b</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row>'
      + '<table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>r</text:p></table:table-cell></table:table-row>'
      + '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>'
      + '</table:table><table:table table:name="B"><table:table-row><table:table-cell><text:p>1</text:p><text:p>2</text:p></table:table-cell></table:table-row></table:table>'
      + '</office:spreadsheet></office:body></office:document-content>';
    const book = readSheet(zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': content }, true));
    assert.deepEqual(book.sheets, [
      { name: 'Лист1', rows: [['a  b', 'x', 'x'], ['r'], ['r']], truncated: false },
      { name: 'B', rows: [['1\n2']], truncated: false },
    ]);
  });

  it('cuts a sheet at the caps and says so', () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS + 2 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const wide = `<row r="1"><c r="A1"><v>1</v></c><c r="${'GZ'}1"><v>far</v></c></row>`;
    assert.equal(MAX_SHEET_COLS, 200, 'GZ is column 208');
    const book = readSheet(zip({ ...XLSX, 'xl/worksheets/sheet1.xml': `<sheetData>${rows}</sheetData>`, 'xl/worksheets/sheet2.xml': `<sheetData>${wide}</sheetData>` }));
    assert.equal(book.sheets[0].rows.length, MAX_SHEET_ROWS);
    assert.equal(book.sheets[0].truncated, true);
    assert.deepEqual(book.sheets[1], { name: 'Empty', rows: [['1']], truncated: true });
  });

  it('refuses what is not an xlsx or ods by the bytes: an old xls, another zip, text', () => {
    const status = (bytes: Buffer) => {
      try {
        readSheet(bytes);
        return 200;
      } catch (e) {
        return (e as { statusCode: number }).statusCode;
      }
    };
    assert.equal(status(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.alloc(40)])), 415);
    assert.equal(status(zip({ 'readme.txt': 'hi' })), 415);
    assert.equal(status(Buffer.from('a,b\n1,2\n')), 415);
    assert.equal(status(Buffer.alloc(0)), 415);
  });

  const status = (bytes: Buffer) => {
    try {
      readSheet(bytes);
      return 200;
    } catch (e) {
      return (e as { statusCode: number }).statusCode;
    }
  };
  const ODS = (body: string) => zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': `<table:table table:name="A">${body}</table:table>` });
  const sheet1 = (xml: string) => zip({ ...XLSX, 'xl/worksheets/sheet1.xml': xml });

  it('reads unclosed tags in linear time', () => {
    const n = 40_000;
    const inputs = [
      sheet1(`<sheetData><row r="1">${'<c r="A1"><v>1'.repeat(n)}</row></sheetData>`),
      sheet1(`<sheetData>${'<row r="1">'.repeat(n)}</sheetData>`),
      zip({ ...XLSX, 'xl/sharedStrings.xml': `<sst>${'<si><rPh><t>x'.repeat(n)}</sst>` }),
      sheet1(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is>${'<t>x'.repeat(n)}</is></c></row></sheetData>`),
      ODS(`<table:table-row>${'<table:table-cell><text:p>x<text:s '.repeat(n)}</table:table-row>`),
    ];
    for (const [i, bytes] of inputs.entries()) {
      const started = performance.now();
      readSheet(bytes);
      assert.ok(performance.now() - started < 1000, `input ${i}: ${Math.round(performance.now() - started)} ms`);
    }
  });

  it('caps what one workbook unpacks to, in total and per file', () => {
    const big = ' '.repeat(MAX_UNPACKED_BYTES / 3 + 1024);
    assert.equal(status(zip({ ...XLSX, 'xl/worksheets/sheet1.xml': big, 'xl/worksheets/sheet2.xml': big, 'xl/sharedStrings.xml': big })), 413);
    assert.equal(status(sheet1(' '.repeat(65 * 1024 * 1024))), 413);
  });

  it('caps the sheets, the text of a cell and the text of the whole answer', () => {
    const many = `<workbook><sheets>${'<sheet name="S" r:id="rId2"/>'.repeat(MAX_SHEETS + 5)}</sheets></workbook>`;
    assert.equal(readSheet(zip({ ...XLSX, 'xl/workbook.xml': many })).sheets.length, MAX_SHEETS);
    const long = 'y'.repeat(MAX_CELL_TEXT + 10);
    const one = readSheet(sheet1(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${long}</t></is></c></row></sheetData>`)).sheets[0];
    assert.equal(one.rows[0][0].length, MAX_CELL_TEXT);
    assert.equal(one.truncated, true);
    const spaced = readSheet(ODS('<table:table-row><table:table-cell><text:p>a<text:s text:c="1000000000"/></text:p></table:table-cell></table:table-row>')).sheets[0];
    assert.equal(spaced.rows[0][0].length, MAX_CELL_TEXT);
    const rows = Math.ceil(MAX_SHEET_TEXT / (MAX_CELL_TEXT * MAX_SHEET_COLS)) + 2;
    const row = (r: number) => `<row r="${r}">${'<c t="s"><v>2</v></c>'.repeat(MAX_SHEET_COLS)}</row>`;
    const shared = `<sst><si><t>Name</t></si><si><t>b</t></si><si><t>${'z'.repeat(MAX_CELL_TEXT)}</t></si></sst>`;
    const wide = readSheet(zip({ ...XLSX, 'xl/sharedStrings.xml': shared, 'xl/worksheets/sheet1.xml': `<sheetData>${Array.from({ length: rows }, (_, i) => row(i + 1)).join('')}</sheetData>` }));
    const total = wide.sheets.flatMap((s) => s.rows.flat()).reduce((n, c) => n + c.length, 0);
    assert.ok(total <= MAX_SHEET_TEXT, `${total} chars`);
    assert.equal(wide.sheets[0].truncated, true);
  });

  it('a broken archive or a huge entity is a 415 or plain text, never a crash', () => {
    const bytes = sheet1('<sheetData/>');
    const end = bytes.length - 22;
    const offset = Buffer.from(bytes);
    offset.writeUInt32LE(bytes.length + 100, end + 16);
    assert.equal(status(offset), 415);
    const local = Buffer.from(bytes);
    local.writeUInt32LE(bytes.length + 100, bytes.readUInt32LE(end + 16) + 42);
    assert.equal(status(local), 415);
    const entity = readSheet(sheet1('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#99999999999;&#x110000;&#65;</t></is></c></row></sheetData>'));
    assert.equal(entity.sheets[0].rows[0][0], '&#99999999999;&#x110000;A');
  });
});
