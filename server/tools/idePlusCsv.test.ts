// The CSV module of the shipped IDE+ plugin: plain browser JavaScript, loaded here by its URL so the types stay out of it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

type Row = { cells: string[]; quoted: boolean[]; raw: string; end: string; source: string[] };
type Csv = {
  parseCsv: (text: string, sep: string) => Row[];
  serializeCsv: (rows: Row[], sep: string) => string;
  withCell: (rows: Row[], r: number, c: number, value: string) => Row[];
  separatorFor: (ext: string, text: string) => string;
};
const csv = (await import(pathToFileURL(join(import.meta.dirname, '../../plugins/ide-plus/ui/csv.js')).href)) as Csv;
const cells = (text: string, sep = ',') => csv.parseCsv(text, sep).map((r) => r.cells);

describe('ide-plus csv', () => {
  it('reads quotes, doubled quotes, separators and line breaks inside quotes, and every line ending', () => {
    assert.deepEqual(cells('a,"b,c","say ""hi"""\r\n"multi\nline",,x\ry'), [['a', 'b,c', 'say "hi"'], ['multi\nline', '', 'x'], ['y']]);
    assert.deepEqual(cells('one\ttwo\n', '\t'), [['one', 'two']]);
    assert.deepEqual(cells(''), []);
    assert.deepEqual(cells('a,\n\nb'), [['a', ''], [''], ['b']]);
    assert.deepEqual(cells('"open'), [['open']]);
  });

  it('writes an unchanged file back byte for byte', () => {
    for (const text of ['a, b ,"c"\r\n"x""y",2\n', 'no newline at the end', '"a"  ,b\n\n', ';;\n']) {
      assert.equal(csv.serializeCsv(csv.parseCsv(text, ','), ','), text);
    }
  });

  it('rewrites only the edited row, keeps its quoting and quotes what needs it', () => {
    const text = 'name,"note"\r\n  Ann ,"x"\r\nBob,y';
    let rows = csv.parseCsv(text, ',');
    rows = csv.withCell(rows, 1, 1, 'has "quote", and comma');
    rows = csv.withCell(rows, 2, 3, 'new\nline');
    assert.equal(csv.serializeCsv(rows, ','), 'name,"note"\r\n  Ann ,"has ""quote"", and comma"\r\nBob,y,,"new\nline"');
    const back = csv.withCell(csv.withCell(rows, 1, 1, 'x'), 2, 3, '');
    assert.equal(csv.serializeCsv(csv.withCell(back, 2, 2, ''), ','), 'name,"note"\r\n  Ann ,"x"\r\nBob,y,,', 'a lengthened row is no longer the same row');
    assert.equal(csv.serializeCsv(csv.withCell(rows, 1, 1, 'x').map((r, i) => (i === 2 ? csv.parseCsv(text, ',')[2] : r)), ','), text);
  });

  it('round trips what it wrote', () => {
    const rows = csv.withCell(csv.parseCsv('a,b\n', ','), 0, 0, 'x,"y"\n');
    assert.deepEqual(cells(csv.serializeCsv(rows, ',')), [['x,"y"\n', 'b']]);
  });

  it('takes the separator from the extension or from the first line', () => {
    assert.equal(csv.separatorFor('tsv', 'a,b'), '\t');
    assert.equal(csv.separatorFor('csv', 'a;b;c\n1,5;2,5;3'), ';');
    assert.equal(csv.separatorFor('csv', 'a,b\n1;2'), ',');
  });
});
