// Planner storage and the file tree of a work tab: temp dirs only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import { createRootMcp, ROOT_PLANNER_TOOLS } from '../chat/rootMcp.ts';
import { MICROTASK_ROUTES } from './microtasks.ts';
import { FOLDER_COLORS } from '../../shared/contract.ts';
import { addFolder, addImage, addNote, fileNote, find, folderOfNotes, itemsOf, listFolders, listNotes, moveProjectsToFolders, moveToFolder, plannerDir, readImage, registerPlanner, removeFolder, removeItem, removeNote, renameFolder, renameNote, saveText, setFolderColor, setFolderOrder, setItem } from './planner.ts';
import { sha256 } from '../memory/util.ts';
import { extraRoots, listDir, locate, MAX_FILE_BYTES, MAX_IMAGE_BYTES, readProjectFile, readProjectImage, registerProjectFiles, writeProjectFile } from './projectFiles.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-planner-')));
after(() => rmSync(base, { recursive: true, force: true }));
const status = (code: number) => (e: Error & { statusCode?: number }) => e.statusCode === code;

describe('planner notes', () => {
  const dir = join(base, 'planner');

  it('saves into the inbox at once, keeps the text and refuses empty notes', () => {
    const note = addNote(dir, '  Позвонить: Васе про "релиз"\nвторая строка\n');
    assert.equal(note.filed, false);
    assert.equal(note.title, 'Позвонить: Васе про "релиз"');
    assert.equal(note.text, 'Позвонить: Васе про "релиз"\nвторая строка');
    assert.ok(note.path.startsWith(join(dir, 'inbox') + '/'));
    assert.deepEqual(listNotes(dir).map((n) => n.id), [note.id]);
    for (const bad of ['', '   ', 5, null, 'x'.repeat(100_001)]) assert.throws(() => addNote(dir, bad), status(400));
  });

  it('files by topic, by date when there is no topic, and survives refiling', () => {
    const note = addNote(dir, 'Обновить брокер');
    const filed = fileNote(dir, note.id, { topic: 'Очередь задач', date: '2026-12-01' });
    assert.equal(filed.path, join(dir, 'general', 'очередь-задач', `${note.id}.md`));
    assert.equal(filed.filed, true);
    assert.equal(filed.text, 'Обновить брокер');
    assert.equal(filed.date, '2026-12-01');
    assert.ok(!existsSync(note.path));

    const again = fileNote(dir, note.id, { topic: null, date: '2026-12-02' });
    assert.equal(again.path, join(dir, 'general', '2026-12-02', `${note.id}.md`));
    assert.equal(listNotes(dir).filter((n) => n.id === note.id).length, 1);
    assert.equal(fileNote(dir, note.id, { topic: 'Тема' }).path, join(dir, 'general', 'тема', `${note.id}.md`));
  });

  it('cannot leave the folder, whatever is passed', () => {
    const note = addNote(dir, 'Заметка');
    for (const id of ['../../etc/passwd', '..', 'a/b', 'a\\b', '', 5, null]) assert.throws(() => fileNote(dir, id, { topic: 't' }), status(400), String(id));
    assert.throws(() => removeNote(dir, '../x'), status(400));
    assert.throws(() => fileNote(dir, 'нет-такой', { topic: 't' }), status(404));
    assert.throws(() => fileNote(dir, note.id, { topic: 't', date: '../x' }), status(400));
    const filed = fileNote(dir, note.id, { topic: '../../../etc' });
    assert.ok(filed.path.startsWith(join(dir, 'general') + '/'));
    assert.ok(!filed.path.split('/').slice(dir.split('/').length).includes('..'));
  });

  it('edits by version: a stale one is refused, a move is not a change, and the title follows only a first line it repeated', () => {
    const note = addNote(dir, 'Старая строка\nвторая');
    const filed = fileNote(dir, note.id, { topic: 'тема' });
    assert.equal(filed.version, note.version);
    const saved = saveText(dir, note.id, '- [ ] Новая строка\n- [ ] \nвторая\n', note.version);
    assert.equal(saved.path, filed.path);
    assert.equal(saved.text, '- [ ] Новая строка\nвторая');
    assert.equal(saved.title, 'Новая строка');
    assert.equal(saved.topic, 'тема');
    assert.notEqual(saved.version, note.version);
    assert.throws(() => saveText(dir, note.id, 'x', note.version), status(409));
    assert.equal(listNotes(dir).find((n) => n.id === note.id)!.text, saved.text);
    for (const bad of ['', '  ', 5, null, 'x'.repeat(100_001)]) assert.throws(() => saveText(dir, note.id, bad, saved.version), status(400));

    const titled = fileNote(dir, note.id, { topic: 'тема', title: 'Своё имя' });
    assert.equal(saveText(dir, note.id, 'Другое', titled.version).title, 'Своё имя');
  });

  it('an edit stays inside the folder: odd ids are refused, a symlink is no note', () => {
    for (const id of ['../../etc/passwd', '..', 'a/b', 'a\\b', '', 5, null]) assert.throws(() => saveText(dir, id, 'x', 'v'), status(400), String(id));
    const outside = join(base, 'outside.md');
    writeFileSync(outside, '---\ntitle: "o"\n---\nчужое');
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    symlinkSync(outside, join(dir, 'inbox', 'ссылка.md'));
    assert.throws(() => saveText(dir, 'ссылка', 'x', 'v'), status(404));
    assert.ok(!listNotes(dir).some((n) => n.id === 'ссылка'));
    assert.match(readFileSync(outside, 'utf8'), /чужое/);
    rmSync(join(dir, 'inbox', 'ссылка.md'));
  });

  it('every microtask template says where it runs', () => {
    const names = readdirSync(join(import.meta.dirname, '../../root/microtasks')).map((n) => n.slice(0, -3)).sort();
    assert.deepEqual(Object.keys(MICROTASK_ROUTES).sort(), names);
    assert.deepEqual(names.filter((n) => MICROTASK_ROUTES[n] === 'service'), ['planner-decompose', 'planner-file', 'quick-start']);
  });

  it('deleting moves the note aside, out of the list', () => {
    const note = addNote(dir, 'Удалить меня');
    removeNote(dir, note.id);
    assert.ok(!listNotes(dir).some((n) => n.id === note.id));
    assert.match(readFileSync(join(dir, '.trash', `${note.id}.md`), 'utf8'), /Удалить меня/);
  });
});

describe('long and odd text', () => {
  const dir = join(base, 'planner-long');
  const para = 'Длинный абзац на несколько строк. ';

  it('comes back exactly: unbroken strings, markdown symbols, frontmatter look-alikes, quotes', () => {
    const texts = [
      [para.repeat(50), '', para.repeat(30)].join('\n'),
      'x'.repeat(50_000),
      `---\ntitle: "чужой"\n---\nтело\n---\nещё`,
      '# заголовок **жирный** `код` [a](b) | таблица | --- ***\n> цитата\n\\ \\n "кавычки" \'одинарные\' {id} {{x}}\n- не пункт\n* [ ] тоже нет\n- [ ] пункт ' + para.repeat(20),
      '\t- [x] с отступом\n🙂'.repeat(100),
    ];
    for (const text of texts) {
      const note = addNote(dir, text);
      const again = listNotes(dir).find((n) => n.id === note.id)!;
      assert.equal(again.text, text.trim());
      assert.ok([...again.title].length <= 80);
      assert.equal(saveText(dir, note.id, again.text, again.version).text, text.trim());
    }
  });

  it('a long first line cut for the title or the id is cut between characters, and the note stays reachable', () => {
    const emoji = addNote(dir, `${'а'.repeat(79)}🙂🙂🙂`);
    assert.equal(emoji.title, `${'а'.repeat(79)}🙂`);
    const astral = addNote(dir, '𝐀'.repeat(100)); // letters outside the basic plane: half of one would make a bad file name
    assert.equal(fileNote(dir, astral.id, { topic: 'т' }).id, astral.id);
    assert.equal(removeNote(dir, astral.id), undefined);
  });
});

describe('titles', () => {
  const dir = join(base, 'planner-titles');

  it('a new name stays through edits and filing; the file and id do not change', () => {
    const note = addNote(dir, 'Первая строка\nвторая');
    const named = renameNote(dir, note.id, '  Новое\nназвание  ');
    assert.equal(named.title, 'Новое название');
    assert.equal(named.path, note.path);
    assert.equal(named.version, note.version);
    assert.equal(saveText(dir, note.id, 'Другая первая', named.version).title, 'Новое название');
    assert.equal(fileNote(dir, note.id, { topic: 'т' }).title, 'Новое название');
    assert.equal([...renameNote(dir, note.id, 'я'.repeat(200)).title].length, 80);
  });

  it('refuses an empty name and a bad id', () => {
    const note = addNote(dir, 'x');
    for (const bad of ['', '   ', 5, null, undefined]) assert.throws(() => renameNote(dir, note.id, bad), status(400), String(bad));
    assert.throws(() => renameNote(dir, '../x', 'y'), status(400));
    assert.throws(() => renameNote(dir, 'нет-такой', 'y'), status(404));
  });
});

describe('folders', () => {
  const dir = join(base, 'planner-folders');

  it('are made, renamed and deleted; names are text and unique; deleting never deletes notes', () => {
    const work = addFolder(dir, '  Работа  ');
    assert.equal(work.name, 'Работа');
    const home = addFolder(dir, 'Дом');
    assert.deepEqual(listFolders(dir).map((f) => f.name), ['Работа', 'Дом']);
    for (const bad of ['', '  ', 5, null, undefined]) assert.throws(() => addFolder(dir, bad), status(400), String(bad));
    assert.throws(() => addFolder(dir, 'работа'), status(409));
    assert.throws(() => renameFolder(dir, home.id, 'РАБОТА'), status(409));
    assert.equal(renameFolder(dir, home.id, 'дом').name, 'дом'); // its own name is free
    assert.throws(() => renameFolder(dir, 'нет', 'x'), status(404));
    assert.throws(() => removeFolder(dir, 'нет'), status(404));

    const note = addNote(dir, 'В папке');
    moveToFolder(dir, note.id, work.id);
    assert.equal(folderOfNotes(dir).get(note.id), work.id);
    removeFolder(dir, work.id);
    assert.equal(folderOfNotes(dir).get(note.id), undefined);
    assert.ok(listNotes(dir).some((n) => n.id === note.id));
    assert.ok(existsSync(note.path));
  });

  it('survive filing, edits, renames and folder renames; moving out and away works; a deleted note leaves no trace', () => {
    const a = addFolder(dir, 'А');
    const b = addFolder(dir, 'Б');
    const note = addNote(dir, 'Заметка');
    moveToFolder(dir, note.id, a.id);
    const filed = fileNote(dir, note.id, { topic: 'тема', title: 'От Claude' });
    assert.equal(folderOfNotes(dir).get(note.id), a.id);
    saveText(dir, note.id, 'Правка', filed.version);
    renameNote(dir, note.id, 'Моё имя');
    fileNote(dir, note.id, { folder: null, topic: 'другая' });
    renameFolder(dir, a.id, 'А2');
    assert.equal(folderOfNotes(dir).get(note.id), a.id);
    assert.doesNotMatch(readFileSync(listNotes(dir).find((n) => n.id === note.id)!.path, 'utf8'), /folder/);

    moveToFolder(dir, note.id, b.id);
    assert.equal(folderOfNotes(dir).get(note.id), b.id);
    moveToFolder(dir, note.id, null);
    assert.equal(folderOfNotes(dir).get(note.id), undefined);
    moveToFolder(dir, note.id, b.id);
    removeNote(dir, note.id);
    assert.ok(!Object.keys(JSON.parse(readFileSync(join(dir, 'folders.json'), 'utf8')).notes).includes(note.id));
  });

  it('have colours: a new one the fewest have from the palette, any #rrggbb by hand, an old one kept if valid or from its place, nothing else', () => {
    const own = join(base, 'planner-colours');
    const a = addFolder(own, 'А');
    const b = addFolder(own, 'Б');
    assert.equal(a.color, FOLDER_COLORS[0]);
    assert.equal(b.color, FOLDER_COLORS[1]);
    assert.equal(setFolderColor(own, a.id, FOLDER_COLORS[1]).color, FOLDER_COLORS[1]);
    assert.equal(addFolder(own, 'В').color, FOLDER_COLORS[0], 'free again');
    assert.equal(setFolderColor(own, b.id, '#12AB9f').color, '#12ab9f', 'any hex, kept lower case');
    assert.equal(listFolders(own).find((f) => f.id === b.id)!.color, '#12ab9f');
    assert.ok((FOLDER_COLORS as readonly string[]).includes(addFolder(own, 'Г').color), 'a new folder still from the palette');
    for (const bad of ['red', '#fff', '#12345g', '#1234567', ' #123456', 5, null, undefined, '" onload="x']) assert.throws(() => setFolderColor(own, a.id, bad), status(400), String(bad));
    assert.throws(() => setFolderColor(own, 'нет', FOLDER_COLORS[0]), status(404));

    const old = join(base, 'planner-old-folders');
    mkdirSync(old);
    writeFileSync(join(old, 'folders.json'), JSON.stringify({ folders: [{ id: 'x', name: 'Старая' }, { id: 'y', name: 'Вторая', color: 'нет такого' }, { id: 'z', name: 'Своя', color: '#010203' }], notes: {} }));
    assert.deepEqual(listFolders(old).map((f) => f.color), [FOLDER_COLORS[0], FOLDER_COLORS[1], '#010203']);
  });

  it('keep the order they are put in: only a permutation of the ids there are', () => {
    const own = join(base, 'planner-order');
    const [a, b, c] = ['А', 'Б', 'В'].map((name) => addFolder(own, name));
    const note = addNote(own, 'x');
    moveToFolder(own, note.id, b.id);
    assert.deepEqual(setFolderOrder(own, [c.id, a.id, b.id]).map((f) => f.name), ['В', 'А', 'Б']);
    assert.deepEqual(listFolders(own).map((f) => f.name), ['В', 'А', 'Б']);
    assert.equal(folderOfNotes(own).get(note.id), b.id, 'notes stay in their folders');
    for (const bad of [[a.id, b.id], [a.id, b.id, c.id, 'нет'], [a.id, a.id, b.id], [a.id, b.id, 'нет'], [a.id, b.id, 5], 'abc', null, undefined, {}]) assert.throws(() => setFolderOrder(own, bad), status(400), JSON.stringify(bad));
    assert.deepEqual(listFolders(own).map((f) => f.name), ['В', 'А', 'Б'], 'a refused order changes nothing');
  });

  it('take a note by name when it is filed; no name leaves it where it is, a wrong one moves nothing', () => {
    const own = join(base, 'planner-file-folder');
    const work = addFolder(own, 'Работа');
    const note = addNote(own, 'Заметка');
    assert.throws(() => fileNote(own, note.id, { folder: 'Нет такой', topic: 'т' }), (e: Error & { statusCode?: number }) => e.statusCode === 404 && /Работа/.test(e.message));
    assert.equal(find(own, note.id).filed, false, 'not moved');
    assert.equal(fileNote(own, note.id, { folder: ' работа ', topic: 'т' }).filed, true);
    assert.equal(folderOfNotes(own).get(note.id), work.id);
    fileNote(own, note.id, { folder: null, topic: 'другая' });
    assert.equal(folderOfNotes(own).get(note.id), work.id, 'null is no way out');
  });

  it('are where the notes of a project go, once: same name, own folder kept, the field gone, a deleted folder stays deleted', () => {
    const own = join(base, 'planner-projects');
    mkdirSync(join(own, 'projects', 'alpha', 'т'), { recursive: true });
    const old = (id: string, project: string, at = join(own, 'projects', 'alpha', 'т')) => writeFileSync(join(at, `${id}.md`), `---\ntitle: "${id}"\ncreated: "2026-11-01T00:00:00.000Z"\nproject: ${JSON.stringify(project)}\ntopic: "т"\n---\nтекст ${id}`);
    const mine = addFolder(own, 'Моя');
    old('первая', 'alpha');
    old('вторая', 'alpha');
    old('третья', 'beta');
    old('четвёртая', 'gamma');
    old('моя-заметка', 'alpha');
    moveToFolder(own, 'моя-заметка', mine.id);
    addFolder(own, 'BETA ПРОЕКТ');
    const version = find(own, 'первая').version;
    const path = find(own, 'первая').path;

    moveProjectsToFolders(own, (key) => ({ alpha: 'Альфа', beta: 'beta проект' })[key] ?? key);

    const names = new Map(listFolders(own).map((f) => [f.id, f.name]));
    const inFolder = (id: string) => names.get(folderOfNotes(own).get(id)!);
    assert.equal(inFolder('первая'), 'Альфа');
    assert.equal(inFolder('вторая'), 'Альфа');
    assert.equal(inFolder('третья'), 'BETA ПРОЕКТ', 'an existing folder of that name');
    assert.equal(inFolder('четвёртая'), 'gamma', 'an unknown project: its key');
    assert.equal(inFolder('моя-заметка'), 'Моя', 'already in a folder: stays');
    assert.equal(listFolders(own).length, 4);
    assert.ok(new Set(listFolders(own).map((f) => f.color)).size === 4);
    // In place, with the text and version as they were, and nothing left of the project.
    assert.equal(find(own, 'первая').path, path);
    assert.equal(find(own, 'первая').version, version);
    assert.equal(find(own, 'первая').topic, 'т');
    for (const note of listNotes(own)) assert.doesNotMatch(readFileSync(note.path, 'utf8'), /^project:/m);

    const alpha = listFolders(own).find((f) => f.name === 'Альфа')!;
    removeFolder(own, alpha.id);
    moveProjectsToFolders(own, () => 'Альфа');
    assert.equal(listFolders(own).some((f) => f.name === 'Альфа'), false);
    assert.equal(folderOfNotes(own).get('первая'), undefined);
  });

  it('stay inside the planner: odd ids are refused, a folder is no path, the file is no note, a damaged file is no crash', () => {
    const f = addFolder(dir, '../../etc');
    assert.equal(f.name, '../../etc');
    assert.match(f.id, /^[0-9a-f]+$/);
    assert.ok(readdirSync(dir).includes('folders.json'));
    assert.ok(!existsSync(join(dir, '..', '..', 'etc')));
    const note = addNote(dir, 'x');
    for (const id of ['../../etc/passwd', '..', 'a/b', 'a\\b', '', 5, null]) assert.throws(() => moveToFolder(dir, id, f.id), status(400), String(id));
    for (const bad of ['../x', '__proto__', 5, undefined, {}]) assert.throws(() => moveToFolder(dir, note.id, bad), status(404), String(bad));
    assert.ok(!listNotes(dir).some((n) => n.id === 'folders'));

    const broken = join(base, 'planner-broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'folders.json'), '{ не json');
    assert.deepEqual(listFolders(broken), []);
    assert.equal(folderOfNotes(broken).size, 0);
    assert.equal(addFolder(broken, 'новая').name, 'новая');
  });

  it('over HTTP: the list carries them, and a folder route leaves the notes alone', async () => {
    const data = join(base, 'http-folders');
    const app = Fastify();
    const topics: string[] = [];
    registerPlanner({ app, paths: { data }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t) } as never);
    const call = async <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const res = await app.inject({ method, url, payload });
      return { status: res.statusCode, body: res.json<T>() };
    };
    const note = (await call<{ id: string }>('POST', '/api/planner', { text: 'Заметка' })).body;
    const url = `/api/planner/${encodeURIComponent(note.id)}`;
    const list = async () => (await call<{ folders: { id: string; name: string; color: string }[]; notes: { folder: string | null; title: string }[] }>('GET', '/api/planner')).body;
    assert.deepEqual((await list()).folders, []);
    assert.equal((await list()).notes[0].folder, null);

    const folder = (await call<{ id: string }>('POST', '/api/planner/folders', { name: 'Работа' })).body;
    assert.equal((await call('POST', '/api/planner/folders', { name: 'Работа' })).status, 409);
    assert.equal((await call('POST', '/api/planner/folders', {})).status, 400);
    assert.equal((await call('PUT', `${url}/folder`, { folder: folder.id })).status, 200);
    assert.equal((await list()).notes[0].folder, folder.id);
    assert.equal((await call('PUT', `${url}/folder`, { folder: 'нет' })).status, 404);
    assert.equal((await call('PUT', `/api/planner/${encodeURIComponent('../x')}/folder`, { folder: folder.id })).status, 400);
    assert.equal((await call('PATCH', `/api/planner/folders/${folder.id}`, { name: 'Дела' })).status, 200);
    assert.equal((await list()).folders[0].name, 'Дела');
    assert.equal((await call('PATCH', `/api/planner/folders/${folder.id}`, { color: FOLDER_COLORS[4] })).status, 200);
    assert.deepEqual((await list()).folders[0], { id: folder.id, name: 'Дела', color: FOLDER_COLORS[4] });
    assert.equal((await call('PATCH', `/api/planner/folders/${folder.id}`, { color: 'red' })).status, 400);
    assert.equal((await call('PATCH', `/api/planner/folders/${folder.id}`, { color: '#abcdef' })).status, 200);
    assert.equal((await list()).folders[0].color, '#abcdef');
    assert.equal((await call('PATCH', url, { title: 'Имя' })).status, 200);
    assert.equal((await list()).notes[0].title, 'Имя');
    assert.equal((await call('PATCH', url, { title: ' ' })).status, 400);
    assert.equal((await call('DELETE', `/api/planner/folders/${folder.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/planner/folders/${folder.id}`)).status, 404);
    const after = await list();
    assert.deepEqual(after.folders, []);
    assert.equal(after.notes.length, 1);
    assert.equal(after.notes[0].folder, null);
    assert.ok(topics.length >= 5);
    await app.close();
  });

  it('a note added with a folder lands in it; an unknown folder is 404 and no note', async () => {
    const data = join(base, 'http-folder-note');
    const app = Fastify();
    registerPlanner({ app, paths: { data }, audit: () => {}, invalidate: () => {} } as never);
    const folder = (await app.inject({ method: 'POST', url: '/api/planner/folders', payload: { name: 'Работа' } })).json<{ id: string }>();
    const res = await app.inject({ method: 'POST', url: '/api/planner', payload: { text: 'В папку', folder: folder.id } });
    assert.equal(res.statusCode, 200);
    const dir = plannerDir({ paths: { data } } as never);
    assert.equal(folderOfNotes(dir).get(res.json<{ id: string }>().id), folder.id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/planner', payload: { text: 'Без папки', folder: null } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/planner', payload: { text: 'Никуда', folder: 'нет' } })).statusCode, 404);
    assert.deepEqual(listNotes(dir).map((n) => n.text).sort(), ['Без папки', 'В папку']);
    await app.close();
  });

  it('over HTTP: reordered by PUT folders/order, a bad list is 400', async () => {
    const data = join(base, 'http-folder-order');
    const app = Fastify();
    registerPlanner({ app, paths: { data }, audit: () => {}, invalidate: () => {} } as never);
    const add = async (name: string) => (await app.inject({ method: 'POST', url: '/api/planner/folders', payload: { name } })).json<{ id: string }>().id;
    const a = await add('А');
    const b = await add('Б');
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/planner/folders/order', payload });
    assert.equal((await put({ ids: [b, a] })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/planner' })).json<{ folders: { id: string }[] }>().folders.map((f) => f.id), [b, a]);
    assert.equal((await put({ ids: [a] })).statusCode, 400);
    assert.equal((await put({})).statusCode, 400);
    await app.close();
  });
});

describe('checklist items', () => {
  const dir = join(base, 'planner-items');
  const body = (id: string) => listNotes(dir).find((n) => n.id === id)!.text;

  it('are plain markdown in the file, empty ones are dropped, the title is the words', () => {
    const note = addNote(dir, '- [ ] Купить домен\n- [ ] \nпросто текст\n- [x] Готово');
    assert.equal(note.title, 'Купить домен');
    assert.equal(note.text, '- [ ] Купить домен\nпросто текст\n- [x] Готово');
    assert.match(readFileSync(note.path, 'utf8'), /\n- \[ \] Купить домен\nпросто текст\n- \[x\] Готово$/);
    assert.throws(() => addNote(dir, '- [ ] \n- [ ]'), status(400));
  });

  it('toggles by number or by exact text, nothing else in the note changes', () => {
    const note = addNote(dir, 'Заголовок\n- [ ] Первый\nтекст\n- [x] Второй');
    const filed = fileNote(dir, note.id, { topic: 't', date: '2026-12-01' });
    setItem(dir, note.id, 1, true);
    assert.equal(body(note.id), 'Заголовок\n- [x] Первый\nтекст\n- [x] Второй');
    setItem(dir, note.id, 'Второй', false);
    assert.equal(body(note.id), 'Заголовок\n- [x] Первый\nтекст\n- [ ] Второй');
    const after = listNotes(dir).find((n) => n.id === note.id)!;
    assert.deepEqual([after.path, after.topic, after.date, after.title], [filed.path, 't', '2026-12-01', 'Заголовок']);
  });

  it('removes one item line; the next item takes its number', () => {
    const note = addNote(dir, 'x\n- [ ] A\n- [ ] B\n- [ ] C');
    removeItem(dir, note.id, 2);
    assert.equal(body(note.id), 'x\n- [ ] A\n- [ ] C');
    removeItem(dir, note.id, 2);
    assert.equal(body(note.id), 'x\n- [ ] A');
  });

  it('refuses a bad reference and an item that changed under the click', () => {
    const note = addNote(dir, '- [ ] A\n- [ ] A\n- [ ] B');
    for (const bad of [0, -1, 1.5, '', '  ', null, undefined, {}]) assert.throws(() => setItem(dir, note.id, bad, true), status(400), String(bad));
    for (const bad of ['yes', 1, null, undefined]) assert.throws(() => setItem(dir, note.id, 1, bad), status(400), String(bad));
    assert.throws(() => setItem(dir, note.id, 4, true), status(404));
    assert.throws(() => setItem(dir, note.id, 'нет', true), status(404));
    assert.throws(() => removeItem(dir, note.id, 'A'), status(409)); // two of them: the number decides
    assert.throws(() => removeItem(dir, note.id, 3, 'A'), status(409));
    assert.throws(() => setItem(dir, '../x', 1, true), status(400));
    assert.equal(body(note.id), '- [ ] A\n- [ ] A\n- [ ] B');
  });

  it('itemsOf numbers them the way a session is told to', () => {
    assert.deepEqual(itemsOf('t\n- [ ] A\n  - [x] B\n* [ ] нет\n- [] нет'), [{ item: 1, done: false, text: 'A' }, { item: 2, done: true, text: 'B' }]);
  });
});

describe('images', () => {
  const dir = join(base, 'planner-images');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

  it('saves under a generated name by what the bytes are, reads back only from its folder', () => {
    const { path } = addImage(dir, png.toString('base64'));
    assert.ok(path.startsWith(join(dir, 'images') + '/'));
    assert.match(path, /\/[\w-]+\.png$/);
    assert.deepEqual(readFileSync(path), png);
    const got = readImage(dir, path.slice(path.lastIndexOf('/') + 1));
    assert.equal(got.type, 'image/png');
    assert.deepEqual(got.bytes, png);
    assert.equal(listNotes(dir).length, 0); // an image is not a note
  });

  it('refuses what is not an image, what is too large, and any other name', () => {
    assert.throws(() => addImage(dir, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')), status(415));
    assert.throws(() => addImage(dir, Buffer.from('BM just a bitmap').toString('base64')), status(415));
    for (const bad of ['', 5, null, undefined]) assert.throws(() => addImage(dir, bad), status(400), String(bad));
    assert.throws(() => addImage(dir, Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64')), status(413));
    for (const bad of ['../x.png', '..%2Fx.png', '..', '.png', 'a/b.png', 'a\\b.png', 'x.svg', 'x.png.txt', '', null]) assert.throws(() => readImage(dir, bad), status(400), String(bad));
    assert.throws(() => readImage(dir, 'нет.png'), status(400));
    assert.throws(() => readImage(dir, 'missing.png'), status(404));
    writeFileSync(join(dir, 'outside.png'), png);
    symlinkSync(join(dir, 'outside.png'), join(dir, 'images', 'link.png'));
    assert.throws(() => readImage(dir, 'link.png'), status(404));
  });

  it('a note of an image has a title, and the path stays as text', () => {
    const { path } = addImage(dir, png.toString('base64'));
    assert.equal(addNote(dir, path).title, 'image');
    const note = addNote(dir, `${path}\nКнопка съехала`);
    assert.equal(note.title, 'Кнопка съехала');
    assert.equal(note.text, `${path}\nКнопка съехала`);
  });
});

test('the root session marks and removes items through its tools', async () => {
  const data = join(base, 'tool-items');
  const topics: string[] = [];
  const ctx = { paths: { data, config: data, root: data }, journal: { listProjects: () => [] }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t) };
  const server = createRootMcp(ctx as never, {} as never, 'root');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const dir = plannerDir(ctx as never);
  const note = addNote(dir, '- [ ] A\n- [ ] B');
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

  const checked = await client.callTool({ name: 'check_planner_item', arguments: { id: note.id, item: 'B', done: true } });
  assert.ok(!checked.isError);
  assert.deepEqual(JSON.parse(text(checked)).items, [{ item: 1, done: false, text: 'A' }, { item: 2, done: true, text: 'B' }]);
  assert.equal(listNotes(dir)[0].text, '- [ ] A\n- [x] B');

  const removed = await client.callTool({ name: 'remove_planner_item', arguments: { id: note.id, item: 1 } });
  assert.ok(!removed.isError);
  assert.equal(listNotes(dir)[0].text, '- [x] B');
  assert.deepEqual(topics, ['planner', 'planner']);

  assert.equal((await client.callTool({ name: 'check_planner_item', arguments: { id: note.id, item: 9, done: true } })).isError, true);
  assert.ok(ROOT_PLANNER_TOOLS.includes('mcp__claude-os__check_planner_item') && ROOT_PLANNER_TOOLS.includes('mcp__claude-os__remove_planner_item'));
  await client.close();
});

test('over HTTP: images, traversal answers with an error, not a file', async () => {
  const data = join(base, 'http-items');
  const app = Fastify({ bodyLimit: 50 * 1024 * 1024 });
  const ctx = { app, paths: { data }, audit: () => {}, invalidate: () => {} };
  registerPlanner(ctx as never);
  writeFileSync(join(base, 'secret.png'), 'secret');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';
  const up = await app.inject({ method: 'POST', url: '/api/planner/images', payload: { name: '../../evil.svg', mediaType: 'image/svg+xml', base64: png } });
  const { path } = up.json<{ path: string }>();
  assert.ok(path.startsWith(join(data, 'planner', 'images') + '/') && path.endsWith('.png'));
  const got = await app.inject({ url: `/api/planner/images/${path.slice(path.lastIndexOf('/') + 1)}` });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal(got.rawPayload.toString('base64'), png);
  assert.equal((await app.inject({ method: 'POST', url: '/api/planner/images', payload: { base64: Buffer.from('text').toString('base64') } })).statusCode, 415);
  for (const bad of [encodeURIComponent('../../../secret.png'), '..%2F..%2F..%2Fsecret.png', '%2e%2e']) {
    const res = await app.inject({ url: `/api/planner/images/${bad}` });
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `${bad}: ${res.statusCode}`);
    assert.notEqual(res.body, 'secret');
  }
  await app.close();
});

test('the root session files a note through its tool, nothing else moves', async () => {
  const data = join(base, 'tool-data');
  const topics: string[] = [];
  const ctx = {
    paths: { data, config: data, root: data },
    journal: { listProjects: () => [{ key: 'alpha-service' }] },
    audit: () => {},
    invalidate: (...t: string[]) => topics.push(...t),
  };
  const server = createRootMcp(ctx as never, {} as never, 'root');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);

  const dir = plannerDir(ctx as never);
  const note = addNote(dir, 'Обновить брокер');
  const folder = addFolder(dir, 'Инфра');
  const refused = await client.callTool({ name: 'file_planner_note', arguments: { id: note.id, folder: 'нет-такой', topic: 't' } });
  assert.equal(refused.isError, true);
  assert.match((refused as { content: { text: string }[] }).content[0].text, /Инфра/);
  assert.equal(listNotes(dir)[0].filed, false);

  const done = await client.callTool({ name: 'file_planner_note', arguments: { id: note.id, folder: 'Инфра', topic: 'Очередь' } });
  assert.ok(!done.isError);
  assert.equal(listNotes(dir)[0].path, join(data, 'planner', 'general', 'очередь', `${note.id}.md`));
  assert.equal(folderOfNotes(dir).get(note.id), folder.id);
  assert.deepEqual(topics, ['planner']);

  // A prompt from before folders still files: the project it names means nothing now.
  const older = addNote(dir, 'Старый шаблон');
  assert.ok(!(await client.callTool({ name: 'file_planner_note', arguments: { id: older.id, project: 'alpha-service', topic: 'Тема' } })).isError);
  assert.equal(folderOfNotes(dir).get(older.id), undefined);
  assert.doesNotMatch(readFileSync(find(dir, older.id).path, 'utf8'), /project/);
  await client.close();
});

test('over HTTP: a note round trip, and traversal answers with an error, not a file', async () => {
  const data = join(base, 'http-data');
  const cwd = join(base, 'http-project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'a.ts'), 'a');
  writeFileSync(join(base, 'secret.txt'), 'secret');
  const app = Fastify();
  const ctx = { app, paths: { data, vault: join(base, 'http-vault') }, audit: () => {}, invalidate: () => {} };
  registerPlanner(ctx as never);
  registerProjectFiles(ctx as never, () => cwd, () => false);

  const created = await app.inject({ method: 'POST', url: '/api/planner', payload: { text: 'Заметка' } });
  assert.equal(created.statusCode, 200);
  const list = (await app.inject({ url: '/api/planner' })).json<{ dir: string; notes: { id: string }[] }>();
  assert.equal(list.dir, join(data, 'planner'));
  assert.equal(list.notes.length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/planner', payload: { text: ' ' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/planner/${encodeURIComponent('..%2Fx')}` })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/planner/${encodeURIComponent(list.notes[0].id)}` })).statusCode, 200);

  assert.deepEqual((await app.inject({ url: '/api/tabs/t/tree' })).json<{ name: string }[]>().map((e) => e.name), ['a.ts']);
  assert.equal((await app.inject({ url: '/api/tabs/t/file?path=a.ts' })).json<{ text: string }>().text, 'a');
  for (const path of ['../secret.txt', '..%2Fsecret.txt', '']) {
    const res = await app.inject({ url: `/api/tabs/t/file?path=${path}` });
    assert.equal(res.statusCode, 400, path);
  }
  assert.equal((await app.inject({ url: `/api/tabs/t/file?path=${encodeURIComponent('/etc/passwd')}` })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/tabs/t/tree?path=..' })).statusCode, 400);
  await app.close();
});

describe('project files', () => {
  const outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret');

  const makeProject = (name: string) => {
    const root = join(base, name);
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'b');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(root, 'dist', 'out.js'), 'x');
    writeFileSync(join(root, 'README.md'), '# hi');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    symlinkSync(outside, join(root, 'leakdir'));
    return root;
  };
  const root = makeProject('plain');
  const names = (list: { name: string }[]) => list.map((e) => e.name);

  it('refuses everything that leads out of the project', () => {
    for (const bad of ['../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', join(outside, 'secret.txt'), '..', 'a\0b', '', null, 7, '.git/config', 'src\\..\\..\\x']) {
      assert.throws(() => readProjectFile(root, bad), status(400), String(bad));
    }
    assert.throws(() => readProjectFile(root, 'leak.txt'), status(403));
    assert.throws(() => readProjectFile(root, 'leakdir/secret.txt'), status(403));
    assert.throws(() => readProjectFile(root, 'нет-файла.ts'), status(404));
    assert.throws(() => readProjectFile(root, 'src'), status(400));
  });

  it('images: only real ones, by content, behind the same checks', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const root = makeProject('images');
    writeFileSync(join(root, 'real.png'), png);
    writeFileSync(join(root, 'photo.txt'), png);
    writeFileSync(join(root, 'text.png'), 'just a text');
    writeFileSync(join(root, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    writeFileSync(join(outside, 'out.png'), png);
    symlinkSync(join(outside, 'out.png'), join(root, 'leak.png'));
    assert.equal(readProjectImage(root, 'real.png').type, 'image/png');
    assert.equal(readProjectImage(root, 'photo.txt').type, 'image/png');
    for (const bad of ['text.png', 'vector.svg', 'src/a.ts']) assert.throws(() => readProjectImage(root, bad), status(415), bad);
    for (const bad of ['../outside/out.png', '/etc/passwd', '.git/config', '']) assert.throws(() => readProjectImage(root, bad), status(400), bad);
    assert.throws(() => readProjectImage(root, 'leak.png'), status(403));
    assert.throws(() => readProjectImage(root, 'src'), status(400));
    assert.throws(() => readProjectImage(root, 'нет.png'), status(404));
  });

  it('an absolute path resolves against the tab or a known project, nothing else', () => {
    const other = makeProject('other');
    assert.deepEqual(locate(root, [other], 'src/a.ts'), { cwd: root, rel: 'src/a.ts' });
    assert.deepEqual(locate(root, [other], join(root, 'src/a.ts')), { cwd: root, rel: 'src/a.ts' });
    assert.deepEqual(locate(root, [other], join(other, 'README.md')), { cwd: other, rel: 'README.md' });
    assert.throws(() => locate(root, [other], join(outside, 'secret.txt')), status(403));
    assert.throws(() => locate(root, [other], '/etc/passwd'), status(403));
    assert.throws(() => locate(root, [other], root), status(403));
    // Still through the file checks: a symlink and .git by way of an absolute path.
    const leak = locate(root, [], join(root, 'leak.txt'));
    assert.throws(() => readProjectFile(leak.cwd, leak.rel), status(403));
    const git = locate(root, [], join(root, '.git/config'));
    assert.throws(() => readProjectFile(git.cwd, git.rel), status(400));
  });

  it('opens an upload by absolute path', async () => {
    const data = join(base, 'roots-data');
    mkdirSync(join(data, 'uploads', 'tab1'), { recursive: true });
    writeFileSync(join(data, 'uploads', 'tab1', 'shot.txt'), 'upload');
    const app = Fastify();
    registerProjectFiles({ app, paths: { data, vault: join(base, 'roots-vault') }, journal: { listProjects: () => [] }, audit: () => {} } as never, () => root, () => false);
    const res = await app.inject({ url: `/api/tabs/t/file?path=${encodeURIComponent(join(data, 'uploads', 'tab1', 'shot.txt'))}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json<{ text: string }>().text, 'upload');
    await app.close();
    // By the uploads root itself, not by /tmp that the test dirs happen to live in.
    const ctx = { paths: { data, vault: join(base, 'roots-vault') } };
    assert.ok(extraRoots(ctx as never).includes(join(data, 'uploads')));
    const upload = join(data, 'uploads', 'tab1', 'shot.txt');
    assert.deepEqual(locate(root, extraRoots(ctx as never), upload), { cwd: join(data, 'uploads'), rel: join('tab1', 'shot.txt') });
  });

  it('extra roots are read only: a write or a reveal there is 403', async () => {
    const data = join(base, 'roots-data');
    mkdirSync(join(data, 'uploads', 'tab1'), { recursive: true });
    const file = join(data, 'uploads', 'tab1', 'keep.txt');
    writeFileSync(file, 'keep\n');
    const app = Fastify();
    registerProjectFiles({ app, paths: { data, vault: join(base, 'roots-vault') }, journal: { listProjects: () => [] }, audit: () => {} } as never, () => root, () => true);
    const read = await app.inject({ url: `/api/tabs/t/file?path=${encodeURIComponent(file)}` });
    assert.equal(read.statusCode, 200, read.body);
    const put = await app.inject({ method: 'PUT', url: '/api/tabs/t/file', payload: { path: file, text: 'changed\n', sha: read.json<{ sha: string }>().sha } });
    assert.equal(put.statusCode, 403, put.body);
    assert.equal(readFileSync(file, 'utf8'), 'keep\n');
    const reveal = await app.inject({ method: 'POST', url: '/api/tabs/t/reveal', payload: { path: file } });
    assert.equal(reveal.statusCode, 403, reveal.body);
    await app.close();
  });

  it('relative path falls back to project root', () => {
    const project = makeProject('fallback');
    const sub = join(project, 'src');
    assert.deepEqual(locate(sub, [], 'README.md', project), { cwd: project, rel: 'README.md' });
    assert.deepEqual(locate(sub, [], 'a.ts', project), { cwd: sub, rel: 'a.ts' }, 'found in cwd: cwd wins');
    assert.deepEqual(locate(sub, [], 'nowhere.ts', project), { cwd: sub, rel: 'nowhere.ts' }, 'nowhere: cwd answers 404');
  });

  it('outside every root is still 403', async () => {
    const data = join(base, 'roots-data');
    const app = Fastify();
    registerProjectFiles({ app, paths: { data, vault: join(base, 'roots-vault') }, journal: { listProjects: () => [] }, audit: () => {} } as never, () => root, () => false);
    for (const path of ['/etc/passwd', '~/.bashrc']) {
      const res = await app.inject({ url: `/api/tabs/t/file?path=${encodeURIComponent(path)}` });
      assert.equal(res.statusCode, 403, path);
    }
    await app.close();
  });

  it('listing refuses the same paths', async () => {
    await assert.rejects(listDir(root, '../outside'), status(400));
    await assert.rejects(listDir(root, '/etc'), status(400));
    await assert.rejects(listDir(root, 'leakdir'), status(403));
    await assert.rejects(listDir(root, 'нет'), status(404));
  });

  it('outside git: one level, directories first, no noise', async () => {
    assert.deepEqual(names(await listDir(root)), ['src', 'README.md']);
    const src = await listDir(root, 'src');
    assert.deepEqual(names(src), ['deep', 'a.ts']);
    assert.deepEqual(src[1], { name: 'a.ts', path: 'src/a.ts', dir: false, size: 20 });
    assert.deepEqual((await listDir(root, 'src/deep')).map((e) => e.path), ['src/deep/b.ts']);
  });

  it('inside git: .gitignore decides, deleted tracked files disappear', async () => {
    const repo = makeProject('repo');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\n*.log\n');
    writeFileSync(join(repo, 'trace.log'), 'x');
    writeFileSync(join(repo, 'gone.ts'), 'x');
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    g('init', '-b', 'main');
    g('add', 'gone.ts');
    rmSync(join(repo, 'gone.ts'));
    const list = names(await listDir(repo));
    assert.ok(list.includes('src') && list.includes('README.md') && list.includes('.gitignore'));
    for (const noise of ['node_modules', 'dist', 'trace.log', 'gone.ts', '.git']) assert.ok(!list.includes(noise), noise);
  });

  it('a save names the version it started from and never touches what it cannot write back exactly', () => {
    writeFileSync(join(root, 'edit.txt'), 'one\n');
    const { sha } = readProjectFile(root, 'edit.txt');
    const saved = writeProjectFile(root, 'edit.txt', 'two\n', sha);
    assert.equal(readFileSync(join(root, 'edit.txt'), 'utf8'), 'two\n');
    assert.equal(saved.sha, sha256('two\n'));
    assert.throws(() => writeProjectFile(root, 'edit.txt', 'three\n', sha), { statusCode: 409 });
    assert.equal(readFileSync(join(root, 'edit.txt'), 'utf8'), 'two\n');

    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    assert.equal(readProjectFile(root, 'latin1.txt').sha, null);
    assert.throws(() => writeProjectFile(root, 'latin1.txt', 'x', null), { statusCode: 422 });
    assert.deepEqual(readFileSync(join(root, 'latin1.txt')), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

    writeFileSync(join(root, 'big.txt'), 'x\n'.repeat(MAX_FILE_BYTES));
    assert.equal(readProjectFile(root, 'big.txt').sha, null);
    assert.throws(() => writeProjectFile(root, 'edit.txt', 'x'.repeat(MAX_FILE_BYTES + 1), saved.sha), { statusCode: 413 });
    assert.throws(() => writeProjectFile(root, 'new.txt', 'x', 'any'), { statusCode: 404 });
    assert.throws(() => writeProjectFile(root, '../outside.txt', 'x', 'any'), { statusCode: 400 });
    assert.throws(() => writeProjectFile(root, '.git/config', 'x', 'any'), { statusCode: 400 });
  });

  it('text, binary and large files are told apart', () => {
    assert.deepEqual(readProjectFile(root, 'src/a.ts'), { path: 'src/a.ts', size: 20, kind: 'text', text: 'export const a = 1;\n', truncated: false, sha: sha256('export const a = 1;\n') });

    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
    assert.deepEqual(readProjectFile(root, 'logo.png'), { path: 'logo.png', size: 6, kind: 'binary', text: null, truncated: false, sha: null });

    const line = 'строка кода\n';
    writeFileSync(join(root, 'big.txt'), line.repeat(Math.ceil((MAX_FILE_BYTES * 2) / Buffer.byteLength(line))));
    const big = readProjectFile(root, 'big.txt');
    assert.equal(big.truncated, true);
    assert.ok(big.size > MAX_FILE_BYTES);
    assert.ok(Buffer.byteLength(big.text!) <= MAX_FILE_BYTES);
    assert.ok(big.text!.endsWith(line) && !big.text!.includes('�'));

    writeFileSync(join(root, 'empty.txt'), '');
    assert.equal(readProjectFile(root, 'empty.txt').text, '');
  });
});
