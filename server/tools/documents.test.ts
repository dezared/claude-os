import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import { createPlannerMcp, createRootMcp, DOCUMENT_TOOLS, SERVICE_TASK_TOOLS } from '../chat/rootMcp.ts';
import { documentIdFromLink, documentLink, knowledgeLabel } from '../../shared/documents.ts';
import { createDocuments, plainText, registerDocuments } from './documents.ts';

const base = mkdtempSync(join(tmpdir(), 'cos-documents-'));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function fresh() {
  const dir = join(base, `case-${n++}`);
  const paths = { data: join(dir, 'data'), config: join(dir, 'config'), root: join(import.meta.dirname, '../../root') };
  return { paths, docs: createDocuments(paths, (key) => key === 'alpha') };
}
const HTML = '<!doctype html><html><head><style>p{color:red}</style></head><body><h1>Заголовок</h1><p>Текст про кота &amp; пса</p></body></html>';

async function connect(paths: { data: string; config: string; root: string }, tab: 'root' | 'work' = 'root') {
  const topics: string[] = [];
  const projects = [{ key: 'alpha', name: 'alpha', root: '/tmp' }];
  const ctx = { paths, journal: { listProjects: () => projects }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t), broadcast: () => {} };
  const server = tab === 'root' ? createRootMcp(ctx as never, {} as never, 'tab-1') : createPlannerMcp(ctx as never, 'tab-1', 'agent', 'alpha');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0].text };
  };
  return { call, client, topics };
}

test('plain text leaves out markup, styles and scripts', () => {
  assert.equal(plainText(HTML), 'Заголовок Текст про кота & пса');
  assert.equal(plainText('<p>a</p><script>var x = "<b>нет</b>"</script><p>b</p>'), 'a b');
});

test('the shipped knowledge file is there, with its kind and name', () => {
  const { docs } = fresh();
  const known = docs.knowledgeList().find((k) => k.id === 'standard');
  assert.ok(known);
  assert.equal(known.kind, 'other');
  assert.equal(known.name, 'Standard');
  assert.equal(known.builtin, true);
  assert.equal(known.customized, false);
  assert.match(docs.knowledge('standard').text, /How to see it/);
});

test('a knowledge file shows its Russian name in the ru UI, its plain one elsewhere', () => {
  const { docs } = fresh();
  const known = docs.knowledgeList().find((k) => k.id === 'standard')!;
  assert.equal(known.nameRu, 'Стандартный');
  assert.equal(knowledgeLabel(known, 'ru').name, 'Стандартный');
  assert.match(knowledgeLabel(known, 'ru').description, /^Любой документ/);
  assert.deepEqual(knowledgeLabel(known, 'en'), { name: 'Standard', description: known.description });
  const own = docs.saveKnowledge('plain', '---\nname: Plain\nkind: plan\n---\nRules\n');
  assert.deepEqual([own.nameRu, knowledgeLabel(own, 'ru').name], [null, 'Plain'], 'without name_ru the ru UI shows the name');
});

test('replacing a knowledge file keeps its Russian name unless new ones are given', () => {
  const { docs } = fresh();
  const replaced = docs.createKnowledge({ id: 'standard', name: 'Standard', kind: 'report', description: 'Reports', text: 'New rules', replace: true });
  assert.deepEqual([replaced.name, replaced.nameRu, replaced.descriptionRu?.slice(0, 14)], ['Standard', 'Стандартный', 'Любой документ']);
  assert.match(docs.knowledge('standard').text, /New rules/);
  const renamed = docs.createKnowledge({ id: 'standard', name: 'Standard', kind: 'report', description: 'Reports', text: 'Rules', replace: true, name_ru: 'Мой стандарт', description_ru: 'Отчёты' });
  assert.deepEqual([renamed.nameRu, renamed.descriptionRu], ['Мой стандарт', 'Отчёты']);
  const fresh2 = docs.createKnowledge({ id: 'plain', name: 'Plain', kind: 'plan', description: 'P', text: 'Rules' });
  assert.equal(fresh2.nameRu, null);
});

test('a document is not saved without a knowledge file behind it', () => {
  const { docs } = fresh();
  assert.throws(() => docs.save({ title: 'A', html: HTML }), /knowledge/);
  assert.throws(() => docs.save({ title: 'A', html: HTML, knowledge: 'нет-такого' }), /No knowledge file нет-такого/);
  assert.deepEqual(docs.list(), []);
});

test('saving: new, then a new version keeping what was not passed', () => {
  const { docs, paths } = fresh();
  const { doc } = docs.save({ title: 'Первый отчёт', html: HTML, knowledge: 'standard', kind: 'report', project: 'alpha' });
  assert.equal(doc.kind, 'report', 'the document says what it is');
  assert.equal(fresh().docs.save({ title: 'Б', html: HTML, knowledge: 'standard' }).doc.kind, 'other', 'or takes the template\'s');
  assert.equal(doc.project, 'alpha');
  assert.equal(doc.version, 1);
  assert.match(doc.summary, /Заголовок/);
  assert.ok(existsSync(join(paths.data, 'documents', `${doc.id}.html`)));
  const next = docs.save({ id: doc.id, html: '<p>Новый</p>' }).doc;
  assert.equal(next.version, 2);
  assert.equal(next.title, 'Первый отчёт');
  assert.equal(next.project, 'alpha');
  assert.equal(next.created, doc.created);
  assert.equal(docs.html(doc.id), '<p>Новый</p>');
  assert.equal(docs.list().length, 1);
});

test('what cannot be saved is refused and says why', () => {
  const { docs } = fresh();
  const good = { title: 'A', html: HTML, knowledge: 'standard' };
  assert.throws(() => docs.save({ ...good, project: 'нет' }), /Project "нет" not found/);
  assert.throws(() => docs.save({ ...good, title: '  ' }), /title/);
  assert.throws(() => docs.save({ ...good, html: 'просто текст' }), /html/);
  assert.throws(() => docs.save({ ...good, html: `<p>${'x'.repeat(5 * 1024 * 1024)}</p>` }), /over 5 MB/);
  assert.throws(() => docs.save({ ...good, id: 'нет-такого' }), /not found/);
  assert.throws(() => docs.get('../../token'), /no document/);
  assert.throws(() => docs.html('..%2Ftoken'), /no document/);
});

test('warnings: what will not work in the sandbox is said at once', () => {
  const { docs } = fresh();
  const save = (html: string) => docs.save({ title: 'A', html, knowledge: 'standard' }).warnings;
  assert.deepEqual(save(HTML), []);
  assert.match(save('<p onclick="x()">a</p><script>1</script>')[0], /Scripts/);
  assert.match(save('<img src="https://example.com/a.png">')[0], /External/);
  assert.deepEqual(save('<img src="data:image/png;base64,AAAA">'), []);
});

test('search: every word, title hits first, a snippet, the cache follows new versions', () => {
  const { docs } = fresh();
  const a = docs.save({ title: 'Про собаку', html: '<p>Здесь есть кот</p>', knowledge: 'standard' }).doc;
  const b = docs.save({ title: 'Кот и хозяин', html: '<p>Тут ничего больше</p>', knowledge: 'standard' }).doc;
  assert.deepEqual(docs.search('кот').map((d) => d.id), [b.id, a.id]);
  assert.match(docs.search('кот')[1].snippet ?? '', /Здесь есть кот/);
  assert.deepEqual(docs.search('кот собаку').map((d) => d.id), [a.id]);
  assert.deepEqual(docs.search('жираф'), []);
  docs.save({ id: a.id, html: '<p>Теперь жираф</p>' });
  assert.deepEqual(docs.search('жираф').map((d) => d.id), [a.id]);
  assert.equal(docs.search('').length, 2);
});

test('patch changes one place only and refuses anything less sure', () => {
  const { docs } = fresh();
  const { doc } = docs.save({ title: 'A', html: '<p>один</p><p>два</p><p>два</p>', knowledge: 'standard' });
  assert.equal(docs.patch(doc.id, 'один', 'три').doc.version, 2);
  assert.equal(docs.html(doc.id), '<p>три</p><p>два</p><p>два</p>');
  assert.throws(() => docs.patch(doc.id, 'два', 'x'), /more than once/);
  assert.throws(() => docs.patch(doc.id, 'нет', 'x'), /no such fragment/);
});

test('sharing keeps a link only from claude.ai, and it survives a new version', () => {
  const { docs } = fresh();
  const { doc } = docs.save({ title: 'A', html: HTML, knowledge: 'standard' });
  assert.throws(() => docs.share(doc.id, 'https://evil.example/claude.ai/'), /claude\.ai/);
  assert.throws(() => docs.share(doc.id, 'http://claude.ai/x'), /claude\.ai/);
  assert.equal(docs.share(doc.id, 'https://claude.ai/artifact/abc').shared?.url, 'https://claude.ai/artifact/abc');
  assert.equal(docs.save({ id: doc.id, html: HTML }).doc.shared?.url, 'https://claude.ai/artifact/abc');
});

test('knowledge: a customization goes to config and the shipped file stays; the original comes back', () => {
  const { docs, paths } = fresh();
  const shipped = readFileSync(join(paths.root, 'document-knowledge/standard.md'), 'utf8');
  const changed = docs.saveKnowledge('standard', '---\nname: Мой\nkind: plan\n---\nСвои правила\n');
  assert.equal(changed.customized, true);
  assert.equal(changed.name, 'Мой');
  assert.ok(changed.path.startsWith(paths.config));
  assert.equal(readFileSync(join(paths.root, 'document-knowledge/standard.md'), 'utf8'), shipped);
  docs.removeKnowledge('standard');
  assert.equal(docs.knowledge('standard').name, 'Standard');
  assert.throws(() => docs.saveKnowledge('x', 'без шапки'), /frontmatter/);
});

test('knowledge: creating does not overwrite by accident; one in use cannot go', () => {
  const { docs } = fresh();
  const input = { name: 'Мой шаблон', kind: 'dashboard' as const, description: 'Для цифр', text: '# Правила' };
  const made = docs.createKnowledge(input);
  assert.equal(made.id, 'мой-шаблон');
  assert.equal(made.kind, 'dashboard');
  assert.throws(() => docs.createKnowledge(input), /already exists/);
  assert.throws(() => docs.createKnowledge({ ...input, id: '../x' }), /Invalid/);
  assert.throws(() => docs.createKnowledge({ ...input, name: 'Отчёт', id: 'standard' }), /already exists/);
  assert.equal(docs.createKnowledge({ ...input, text: '# Другие', replace: true }).text.includes('# Другие'), true);
  docs.save({ title: 'A', html: HTML, knowledge: made.id });
  assert.throws(() => docs.removeKnowledge(made.id), /knowledge file мой-шаблон: 1/);
});

test('the tools: nothing is saved until the basis was read, then the link comes back', async () => {
  const { paths } = fresh();
  const { call, topics, client } = await connect(paths);
  const html = { title: 'Отчёт', knowledge: 'standard', html: HTML, project: null };

  const noBasis = await call('save_document', { ...html, knowledge: 'нет-такого' });
  assert.equal(noBasis.error, true);
  assert.match(noBasis.text, /create_document_knowledge/);
  const none = await call('save_document', { title: 'X', html: HTML });
  assert.equal(none.error, true);
  assert.match(none.text, /knowledge/);

  const unread = await call('save_document', html);
  assert.equal(unread.error, true);
  assert.match(unread.text, /read_document_knowledge\("standard"\)/);

  assert.match((await call('read_document_knowledge', { id: 'standard' })).text, /How to see it/);
  const saved = await call('save_document', html);
  assert.equal(saved.error, false);
  const answer = JSON.parse(saved.text);
  assert.equal(answer.link, documentLink(answer.id));
  assert.match(answer.answer, /\[Отчёт\]\(\/documents\//);
  assert.deepEqual(topics, ['documents']);

  const listed = JSON.parse((await call('list_documents', {})).text);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].link, answer.link);
  assert.equal(JSON.parse((await call('list_documents', { query: 'кота' })).text).length, 1);
  assert.equal(JSON.parse((await call('list_documents', { project: 'alpha' })).text).length, 0);
  assert.equal(JSON.parse((await call('read_document', { id: answer.id })).text).html, HTML);

  assert.equal((await call('patch_document', { id: answer.id, find: 'Заголовок', replace: 'Другой' })).error, false);
  assert.match(JSON.parse((await call('read_document', { id: answer.id })).text).html, /Другой/);
  assert.equal((await call('set_document_share', { id: answer.id, url: 'https://example.com/' })).error, true);
  assert.equal(JSON.parse((await call('set_document_share', { id: answer.id, url: 'https://claude.ai/artifact/x' })).text).shared.url, 'https://claude.ai/artifact/x');
  await client.close();
});

test('the tools: with no basis Claude makes one and can build on it at once', async () => {
  const { paths } = fresh();
  const { call, client } = await connect(paths);
  const made = JSON.parse((await call('create_document_knowledge', { name: 'Дешборд затрат', kind: 'dashboard', description: 'Цифры за месяц', text: '# Как строить' })).text);
  assert.ok(made.path.startsWith(paths.config));
  assert.equal(JSON.parse((await call('list_document_knowledge', {})).text).some((k: { id: string }) => k.id === made.id), true);
  const saved = await call('save_document', { title: 'Затраты', knowledge: made.id, html: HTML, project: null });
  assert.equal(saved.error, false);
  await client.close();
});

test('the tools in a work tab: a new document lands in the tab\'s project, all of them go without a prompt', async () => {
  const { paths } = fresh();
  const { call, client } = await connect(paths, 'work');
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const full of DOCUMENT_TOOLS) assert.ok(names.includes(full.replace('mcp__claude-os__', '')), full);
  for (const full of DOCUMENT_TOOLS) assert.ok(SERVICE_TASK_TOOLS.includes(full), full);
  await call('read_document_knowledge', { id: 'standard' });
  const { id } = JSON.parse((await call('save_document', { title: 'A', knowledge: 'standard', html: HTML })).text);
  assert.equal(JSON.parse((await call('read_document', { id })).text).project, 'alpha');
  await client.close();
});

test('over HTTP: the HTML comes under a sandbox policy that survives opening it by hand', async () => {
  const { paths, docs } = fresh();
  const { doc } = docs.save({ title: 'Отчёт', html: '<p>x</p><script>alert(1)</script>', knowledge: 'standard' });
  const app = Fastify();
  const closed: string[] = [];
  const ctx = { app, paths, journal: { listProjects: () => [] }, audit: () => {}, invalidate: () => {}, chat: { openDocument: (d: { id: string }) => ({ id: 'tab', document: d.id }), closeDocument: (id: string) => closed.push(id) } };
  registerDocuments(ctx as never);

  const list = await app.inject({ url: '/api/documents' });
  assert.equal(list.json()[0].id, doc.id);
  assert.equal((await app.inject({ url: `/api/documents?q=${encodeURIComponent('нет такого')}` })).json().length, 0);

  const page = await app.inject({ url: `/api/documents/${encodeURIComponent(doc.id)}/html` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  const csp = page.headers['content-security-policy'] as string;
  assert.match(csp, /^sandbox;/);
  assert.ok(!csp.includes('allow-scripts') && !csp.includes('allow-same-origin'));
  assert.match(csp, /default-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['content-disposition'], undefined);

  const file = await app.inject({ url: `/api/documents/${encodeURIComponent(doc.id)}/html?download=1` });
  assert.match(file.headers['content-disposition'] as string, /^attachment/);
  assert.match(file.headers['content-security-policy'] as string, /^sandbox;/);

  assert.equal((await app.inject({ url: '/api/documents/..%2F..%2Ftoken/html' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/documents/${encodeURIComponent(doc.id)}/tab` })).json().document, doc.id);

  const custom = await app.inject({ method: 'PUT', url: '/api/document-knowledge/standard', payload: { text: '---\nname: Свой\n---\nТекст\n' } });
  assert.equal(custom.json().customized, true);
  assert.equal((await app.inject({ url: '/api/document-knowledge' })).json().find((k: { id: string }) => k.id === 'standard').name, 'Свой');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/document-knowledge/standard' })).statusCode, 200);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/documents/${encodeURIComponent(doc.id)}` })).statusCode, 200);
  assert.deepEqual(closed, [doc.id]);
  assert.equal((await app.inject({ url: `/api/documents/${encodeURIComponent(doc.id)}` })).statusCode, 404);
  await app.close();
});

test('a chat link and its id go both ways, and nothing else counts as one', () => {
  const id = '2026-11-07-отчёт-о-доработке-a1b2';
  assert.equal(documentIdFromLink(documentLink(id)), id);
  assert.equal(documentIdFromLink('/documents/a/b'), null);
  assert.equal(documentIdFromLink('https://evil.example/documents/a'), null);
  assert.equal(documentIdFromLink('/documents/%E0%A4%A'), null);
});
