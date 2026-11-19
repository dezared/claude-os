// Tables: CSV and TSV edited cell by cell and saved through the file route, xlsx and ods read through the server's sheet route.
import { parseCsv, separatorFor, serializeCsv, withCell } from './csv.js';

export const TABLE_CSS = `
.idep-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.idep-table { border-collapse: separate; border-spacing: 0; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--color-soft); }
.idep-table th, .idep-table td { max-width: 320px; height: 24px; padding: 0 8px; border-right: 1px solid var(--color-line2); border-bottom: 1px solid var(--color-line2); white-space: pre; overflow: hidden; text-overflow: ellipsis; text-align: left; vertical-align: middle; }
.idep-table thead th { position: sticky; top: 0; z-index: 2; background: var(--color-raised); color: var(--color-fg); font-weight: 600; }
.idep-table .idep-num { position: sticky; left: 0; z-index: 1; min-width: 36px; background: var(--color-bg); color: var(--color-dim); text-align: right; user-select: none; }
.idep-table thead .idep-num { z-index: 3; background: var(--color-raised); }
.idep-table .idep-cell { cursor: text; }
.idep-table .idep-cell:hover { background: var(--color-raised); }
.idep-table .idep-editing { padding: 0; overflow: visible; }
.idep-cell-input { display: block; width: 100%; min-width: 120px; height: 24px; padding: 3px 7px; border: 0; outline: 2px solid var(--color-accent); outline-offset: -2px; resize: none; background: var(--color-bg); color: var(--color-fg); font: inherit; white-space: pre; overflow: hidden; }
.idep-note { flex: none; padding: 3px 10px; border-top: 1px solid var(--color-line2); font-size: 11px; color: var(--color-dim); }
.idep-sheets { flex: none; display: flex; gap: 2px; padding: 2px 6px; border-top: 1px solid var(--color-line2); overflow-x: auto; }
`;

const MAX_SHOWN = 5000;
// Only the rows in view are in the page, with spacers for the rest: 5000 rows of 200 cells would stall it.
// The height is the cell's in TABLE_CSS; a taller row with line breaks only shifts the window a little.
const ROW_HEIGHT = 24;
const OVERSCAN = 20;

// Set once by makeTables: the app's React and the plugin's own strings and pieces.
let R;
let deps;
const h = (...args) => R.createElement(...args);
const useEffect = (...args) => R.useEffect(...args);
const useState = (value) => R.useState(value);
const rootClass = (setPaneWidth) => `idep-root${setPaneWidth ? ' idep-resizable' : ''}`;
const fileUrl = (tabId) => `/api/tabs/${encodeURIComponent(tabId)}/file`;

function CellInput({ value, onCommit, onCancel }) {
  const onKeyDown = (e) => {
    if (e.key === 'Escape') onCancel();
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (e.altKey) document.execCommand('insertText', false, '\n'); // a line break inside the cell, as in spreadsheets
    else e.currentTarget.blur();
  };
  return h('textarea', { className: 'idep-cell-input', 'data-testid': 'ide-plus-cell-input', autoFocus: true, defaultValue: value, rows: 1, spellCheck: false, onKeyDown, onBlur: (e) => onCommit(e.currentTarget.value) });
}

function Row({ cells, index, columns, tag, edit }) {
  const out = [h(tag, { key: 'n', className: 'idep-num' }, index + 1)];
  for (let c = 0; c < columns; c++) {
    const value = cells[c] ?? '';
    const editing = edit?.at && edit.at.r === index && edit.at.c === c;
    const props = { key: c, title: value.length > 40 ? value : undefined };
    if (!edit) out.push(h(tag, props, value));
    else if (editing) out.push(h(tag, { ...props, className: 'idep-editing' }, h(CellInput, { value, onCommit: (v) => edit.commit(index, c, v), onCancel: () => edit.setAt(null) })));
    else out.push(h(tag, { ...props, className: 'idep-cell', onClick: () => edit.setAt({ r: index, c }) }, value));
  }
  return h('tr', null, out);
}

/** The first row stays on top while the rest scrolls, and so do the row numbers on the left. */
function Grid({ rows, edit }) {
  const [view, setView] = useState({ top: 0, height: window.innerHeight });
  const columns = Math.max(1, ...rows.slice(0, MAX_SHOWN).map((r) => r.length));
  const [head, ...body] = rows.slice(0, MAX_SHOWN);
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(body.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const spacer = (key, count) => count > 0 && h('tr', { key, 'aria-hidden': true }, h('td', { colSpan: columns + 1, style: { height: count * ROW_HEIGHT, padding: 0, border: 0 } }));
  const onScroll = (e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
  return h('div', { className: 'idep-table-wrap', onScroll },
    h('table', { className: 'idep-table', 'data-testid': 'ide-plus-table' },
      head && h('thead', null, h(Row, { cells: head, index: 0, columns, tag: 'th', edit })),
      h('tbody', null,
        spacer('above', first),
        body.slice(first, last).map((cells, i) => h(Row, { key: first + i, cells, index: first + i + 1, columns, tag: 'td', edit })),
        spacer('below', body.length - last),
      ),
    ),
    rows.length > MAX_SHOWN && h('p', { className: 'idep-note' }, deps.text.rowsCut.replace('{n}', MAX_SHOWN)),
  );
}

// A draft from the text view wins over the disk, as it does there; its text has plain \n, so a save puts the file's line ending back.
function fromSource(key, file, sep) {
  const draft = deps.drafts.get(key);
  return draft ? { rows: parseCsv(draft.text, sep), draft: true, sha: draft.sha } : { rows: parseCsv(file.text, sep), draft: false, sha: file.sha };
}

function useCsv(key, file, sep) {
  const [state, setState] = useState(() => fromSource(key, file, sep));
  useEffect(() => setState(fromSource(key, file, sep)), [file]);
  const eol = file.text.includes('\r\n') ? '\r\n' : '\n';
  const output = (rows, draft) => (draft ? serializeCsv(rows, sep).replace(/\n/g, eol) : serializeCsv(rows, sep));
  const commit = (r, c, value) => {
    const rows = withCell(state.rows, r, c, value);
    const text = output(rows, state.draft);
    if (text === file.text) deps.drafts.delete(key);
    else deps.drafts.set(key, { text: deps.normalize(text), sha: state.sha });
    setState({ ...state, rows });
  };
  const text = output(state.rows, state.draft);
  return { state, commit, text, dirty: text !== file.text, discard: () => deps.drafts.delete(key) };
}

function useSave({ tabId, path, setLatest, csv }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const write = async (sha) => {
    setBusy(true);
    try {
      const fresh = await deps.api(fileUrl(tabId), { method: 'PUT', body: { path, text: csv.text, sha } });
      csv.discard();
      setLatest(fresh);
      setSaved(true);
    } catch (e) {
      // A change on disk shows as the conflict bar: the edits stay until one of its buttons is pressed.
      const fresh = await deps.api(`${fileUrl(tabId)}?path=${encodeURIComponent(path)}`).catch(() => null);
      if (fresh) setLatest(fresh);
      if (!fresh || fresh.sha === sha) deps.toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, saved: saved && !csv.dirty, write };
}

function Conflict({ busy, overwrite, takeDisk }) {
  const { text } = deps;
  return h('div', { role: 'alert', className: 'idep-conflict' },
    h('span', null, text.conflict),
    h('button', { type: 'button', className: 'idep-btn', disabled: busy, onClick: overwrite }, text.overwrite),
    h('button', { type: 'button', className: 'idep-btn', disabled: busy, onClick: takeDisk }, text.takeDisk),
  );
}

function CsvBar({ modes, editable, dirty, saved, disabled, onSave }) {
  const { text } = deps;
  return h('div', { className: 'idep-bar' },
    modes,
    !editable && h('span', null, text.readonly),
    dirty && h('span', { className: 'idep-dot', role: 'img', 'aria-label': text.unsaved, title: text.unsaved }),
    saved && h('span', { role: 'status' }, text.saved),
    h('span', { className: 'idep-grow' }),
    editable && h('button', { type: 'button', className: 'idep-btn idep-primary', disabled, title: 'Ctrl+S', onClick: onSave }, text.save),
  );
}

function CsvTable({ tabId, path, file, setLatest, modes, setPaneWidth }) {
  const { useStoredWidth, ResizeHandle } = deps;
  const key = `${tabId}:${path}`;
  const csv = useCsv(key, file, separatorFor(deps.extension(path), file.text));
  const save = useSave({ tabId, path, setLatest, csv });
  const [at, setAt] = useState(null);
  useStoredWidth(setPaneWidth);
  const editable = file.sha !== null;
  const conflict = csv.dirty && csv.state.sha !== file.sha;
  const commit = (r, c, value) => {
    setAt(null);
    csv.commit(r, c, value);
  };
  const canSave = csv.dirty && !conflict && editable;
  const onKeyDown = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyS') return;
    e.preventDefault();
    if (canSave) void save.write(csv.state.sha);
  };
  return h('div', { className: rootClass(setPaneWidth), onKeyDown },
    h(CsvBar, { modes, editable, dirty: csv.dirty, saved: save.saved, disabled: !canSave || save.busy, onSave: () => save.write(csv.state.sha) }),
    conflict && h(Conflict, { busy: save.busy, overwrite: () => save.write(file.sha), takeDisk: () => { csv.discard(); setLatest({ ...file }); } }),
    h(Grid, { rows: csv.state.rows.map((r) => r.cells), edit: editable ? { at, setAt, commit } : null }),
    setPaneWidth && h(ResizeHandle, { setPaneWidth }),
  );
}

/** Table or text: the text view is the plugin's editor, and a draft made in either shows in the other. */
function CsvView(props) {
  const { tabId, path, file } = props;
  const { text, View } = deps;
  const [mode, setMode] = useState('table');
  const [latest, setLatest] = useState(file);
  useEffect(() => setLatest(file), [file]);
  // The text view saves on its own: coming back, the table asks for the file again.
  useEffect(() => {
    if (mode !== 'table') return undefined;
    let stale = false;
    deps.api(`${fileUrl(tabId)}?path=${encodeURIComponent(path)}`).then((fresh) => !stale && setLatest(fresh), () => {});
    return () => { stale = true; };
  }, [mode]);
  const modes = h('span', { className: 'idep-seg' },
    h('button', { type: 'button', className: 'idep-btn', 'aria-pressed': mode === 'table', onClick: () => setMode('table') }, text.table),
    h('button', { type: 'button', className: 'idep-btn', 'aria-pressed': mode === 'text', onClick: () => setMode('text') }, text.plain),
  );
  if (mode === 'text') return h(View, { ...props, file: latest, extra: modes });
  return h(CsvTable, { tabId, path, file: latest, setLatest, modes, setPaneWidth: props.setPaneWidth });
}

function Sheet({ book, active, setActive }) {
  const sheet = book.sheets[active] ?? book.sheets[0];
  if (!sheet) return h('p', { className: 'idep-failed' }, deps.text.sheetEmpty);
  return h(R.Fragment, null,
    h(Grid, { rows: sheet.rows, edit: null }),
    sheet.truncated && h('p', { className: 'idep-note' }, deps.text.sheetCut),
    book.sheets.length > 1 && h('div', { className: 'idep-sheets', role: 'tablist' }, book.sheets.map((s, i) => h('button', { key: i, type: 'button', role: 'tab', className: 'idep-btn', 'aria-selected': s === sheet, 'aria-pressed': s === sheet, onClick: () => setActive(i) }, s.name))),
  );
}

function SheetView({ tabId, path, setPaneWidth }) {
  const { text, useStoredWidth, ResizeHandle } = deps;
  const [book, setBook] = useState(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  useStoredWidth(setPaneWidth);
  useEffect(() => {
    let stale = false;
    setFailed(false);
    deps.api(`/api/tabs/${encodeURIComponent(tabId)}/sheet?path=${encodeURIComponent(path)}`).then((b) => !stale && setBook(b), () => !stale && setFailed(true));
    return () => { stale = true; };
  }, [path]);
  return h('div', { className: rootClass(setPaneWidth) },
    h('div', { className: 'idep-bar' }, h('span', null, text.table), h('span', null, `· ${text.readonly}`)),
    failed ? h('p', { role: 'alert', className: 'idep-failed' }, text.sheetFailed) : book && h(Sheet, { book, active, setActive }),
    setPaneWidth && h(ResizeHandle, { setPaneWidth }),
  );
}

export function makeTables(given) {
  R = given.React;
  deps = given;
  return { CsvView, SheetView };
}
