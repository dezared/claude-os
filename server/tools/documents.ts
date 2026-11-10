// The library of HTML documents. A document is two files under data/documents: <id>.html and <id>.json, and it is
// always built from a knowledge file: a .md in root/document-knowledge (ships with the app) or config/document-knowledge
// (the user's, wins over a shipped one of the same id, so an update of the app never overwrites a customization).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DOCUMENT_KINDS, type DocumentInfo, type DocumentKind, type DocumentKnowledge, type DocumentKnowledgeInfo } from '../../shared/contract.ts';
import { DOCUMENT_CSP } from '../../shared/documents.ts';
import type { Ctx, Paths } from '../context.ts';
import { httpError, parseFrontmatter, safely } from '../memory/util.ts';

const MAX_HTML = 5 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_SUMMARY = 300;
const MAX_KNOWLEDGE = 200_000;
const SLUG_LENGTH = 48;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u; // one name: no dot, no slash, nothing that leaves the folder
const SHARE_URL = /^https:\/\/(?:[\w-]+\.)?(?:claude\.ai|claude\.site)\//;

const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, SLUG_LENGTH).replace(/^-+|-+$/g, '');

function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function plainText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// None of these break a document, they just will not work in it: the session that wrote it gets to know right away.
function warningsFor(html: string): string[] {
  const out: string[] = [];
  if (/<script\b/i.test(html) || /\son\w+\s*=/i.test(html)) out.push('Scripts do not run: the document is shown in a sandbox without JS. Build the look and the charts with HTML, CSS and inline SVG.');
  if (/(?:src|srcset)\s*=\s*["']?(?:https?:)?\/\//i.test(html) || /url\(\s*["']?(?:https?:)?\/\//i.test(html) || /<link\b[^>]*\bhref/i.test(html)) out.push('External files do not load. Put styles in <style>, images and fonts in data: URLs.');
  return out;
}

export interface DocumentInput {
  id?: string;
  title?: string;
  project?: string | null;
  knowledge?: string;
  kind?: DocumentKind; // what this document is; a general template such as `standard` fits several
  html?: string;
  summary?: string;
}

export interface KnowledgeInput {
  id?: string;
  name: string;
  kind: DocumentKind;
  description: string;
  text: string;
  replace?: boolean;
  name_ru?: string; // what the ru UI shows; a replacement keeps the old one when this is missing
  description_ru?: string;
}

export function createDocuments(paths: Pick<Paths, 'data' | 'config' | 'root'>, isProject: (key: string) => boolean) {
  const dir = join(paths.data, 'documents');
  const userKnowledge = join(paths.config, 'document-knowledge');
  const shippedKnowledge = join(paths.root, 'document-knowledge');
  const texts = new Map<string, { version: number; text: string }>(); // the search does not parse what has not changed

  const checkId = (id: string, what: string) => {
    if (!SAFE_ID.test(id)) throw httpError(404, `no ${what} ${id}`);
    return id;
  };
  const metaFile = (id: string) => join(dir, `${id}.json`);
  const htmlFile = (id: string) => join(dir, `${id}.html`);

  function get(id: string): DocumentInfo {
    checkId(id, 'document');
    try {
      return JSON.parse(readFileSync(metaFile(id), 'utf8')) as DocumentInfo;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw httpError(404, `Document ${id} not found. list_documents gives the list.`, 'documentNotFound', { id });
      throw err;
    }
  }

  const html = (id: string) => {
    get(id);
    return readFileSync(htmlFile(id), 'utf8');
  };

  function list(): DocumentInfo[] {
    const names = safely(() => readdirSync(dir), [] as string[]).filter((n) => n.endsWith('.json'));
    const docs = names.map((n) => safely(() => JSON.parse(readFileSync(join(dir, n), 'utf8')) as DocumentInfo, null));
    return docs.filter((d): d is DocumentInfo => d !== null).sort((a, b) => b.updated - a.updated);
  }

  function textOf(doc: DocumentInfo): string {
    const known = texts.get(doc.id);
    if (known?.version === doc.version) return known.text;
    const text = safely(() => plainText(readFileSync(htmlFile(doc.id), 'utf8')), '');
    texts.set(doc.id, { version: doc.version, text });
    return text;
  }

  // Every word somewhere in the document; a hit in the title goes first.
  function search(q: string): DocumentInfo[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return list();
    const hits: { doc: DocumentInfo; title: boolean }[] = [];
    for (const doc of list()) {
      const title = doc.title.toLowerCase();
      const text = textOf(doc);
      const lower = text.toLowerCase();
      const all = `${title} ${doc.summary.toLowerCase()} ${lower}`;
      if (!words.every((w) => all.includes(w))) continue;
      const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      const snippet = at === undefined ? undefined : `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + 140)}`;
      hits.push({ doc: { ...doc, ...(snippet ? { snippet } : {}) }, title: words.every((w) => title.includes(w)) });
    }
    return hits.sort((a, b) => Number(b.title) - Number(a.title)).map((h) => h.doc);
  }

  // ---------- Knowledge files ----------

  const fileIn = (folder: string, id: string) => join(folder, `${id}.md`);

  function describe(id: string, count: number): DocumentKnowledge | null {
    const own = safely(() => readFileSync(fileIn(userKnowledge, id), 'utf8'), null);
    const shipped = safely(() => readFileSync(fileIn(shippedKnowledge, id), 'utf8'), null);
    const text = own ?? shipped;
    if (text === null) return null;
    const { data } = parseFrontmatter(text);
    const kind = DOCUMENT_KINDS.includes(data.kind as DocumentKind) ? data.kind as DocumentKind : 'other';
    return { id, name: data.name || id, nameRu: data.name_ru || null, kind, description: data.description ?? '', descriptionRu: data.description_ru || null, builtin: shipped !== null, customized: own !== null, path: fileIn(own !== null ? userKnowledge : shippedKnowledge, id), documents: count, text };
  }

  function knowledgeList(): DocumentKnowledgeInfo[] {
    const ids = new Set([userKnowledge, shippedKnowledge].flatMap((folder) => safely(() => readdirSync(folder), [] as string[]).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))));
    const docs = list();
    return [...ids].filter((id) => SAFE_ID.test(id)).flatMap((id) => {
      const k = describe(id, docs.filter((d) => d.knowledge === id).length);
      if (!k) return [];
      const { text: _text, ...info } = k;
      return [info];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function knowledge(id: string): DocumentKnowledge {
    checkId(id, 'knowledge file');
    const found = describe(id, list().filter((d) => d.knowledge === id).length);
    if (!found) throw httpError(404, `No knowledge file ${id}. list_document_knowledge gives the list, create_document_knowledge makes a new one.`, 'knowledgeNotFound', { id });
    return found;
  }

  function createKnowledge(input: KnowledgeInput): DocumentKnowledge {
    const id = input.id ?? slug(input.name);
    if (!SAFE_ID.test(id)) throw httpError(400, `Invalid knowledge file id: ${JSON.stringify(id)}. Letters, digits, "-", "_".`);
    if (!input.replace && describe(id, 0)) throw httpError(409, `Knowledge file ${id} already exists. Read it with read_document_knowledge; replace: true replaces it.`);
    const before = input.replace ? describe(id, 0) : null;
    const nameRu = input.name_ru?.trim() || before?.nameRu;
    const descriptionRu = input.description_ru?.trim() || before?.descriptionRu;
    const file = [
      '---',
      `name: ${JSON.stringify(input.name.trim())}`,
      ...(nameRu ? [`name_ru: ${JSON.stringify(nameRu)}`] : []),
      `kind: ${input.kind}`,
      `description: ${JSON.stringify(input.description.trim())}`,
      ...(descriptionRu ? [`description_ru: ${JSON.stringify(descriptionRu)}`] : []),
      '---',
      `${input.text.trim()}\n`,
    ].join('\n');
    return saveKnowledge(id, file);
  }

  function saveKnowledge(id: string, text: string): DocumentKnowledge {
    checkId(id, 'knowledge file');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_KNOWLEDGE) throw httpError(400, `a knowledge file is text, up to ${MAX_KNOWLEDGE} characters`);
    const { data, body } = parseFrontmatter(text);
    if (!data.name || !body.trim()) throw httpError(400, 'A knowledge file needs frontmatter with name and a text with the rules.', 'knowledgeNeedsFrontmatter');
    writeWhole(fileIn(userKnowledge, id), text);
    return knowledge(id);
  }

  // A shipped file comes back from under the user's; a file of the user's alone goes, unless documents still stand on it.
  function removeKnowledge(id: string): void {
    const found = knowledge(id);
    if (!found.builtin && found.documents > 0) throw httpError(409, `Documents built on knowledge file ${id}: ${found.documents}.`, 'knowledgeInUse', { id, n: found.documents });
    rmSync(fileIn(userKnowledge, id), { force: true });
  }

  // ---------- Saving ----------

  function checkHtml(value: unknown): string {
    if (typeof value !== 'string' || !/<[a-z!]/i.test(value)) throw httpError(400, 'html: needs the text of an HTML document.');
    if (Buffer.byteLength(value) > MAX_HTML) throw httpError(400, `html is over ${MAX_HTML / 1024 / 1024} MB. Shrink the images or split the document.`);
    return value;
  }

  function checkProject(value: string | null): string | null {
    if (value !== null && !isProject(value)) throw httpError(400, `Project "${value}" not found. list_projects gives the keys.`);
    return value;
  }

  function write(doc: DocumentInfo, text: string): DocumentInfo {
    writeWhole(htmlFile(doc.id), text);
    writeWhole(metaFile(doc.id), JSON.stringify(doc, null, 1));
    return doc;
  }

  const summaryOf = (value: string | undefined, text: string) => {
    const clean = value?.trim() || plainText(text);
    return clean.length > MAX_SUMMARY ? `${clean.slice(0, MAX_SUMMARY - 1)}…` : clean;
  };

  // With an id: a new version of that document, whatever is not passed stays. Without: a new document.
  function save(input: DocumentInput): { doc: DocumentInfo; warnings: string[] } {
    const old = input.id ? get(input.id) : null;
    const text = checkHtml(input.html);
    const title = (input.title ?? old?.title ?? '').trim();
    if (!title || title.length > MAX_TITLE) throw httpError(400, `title: text up to ${MAX_TITLE} characters.`);
    const knowledgeId = input.knowledge ?? old?.knowledge;
    if (!knowledgeId) throw httpError(400, 'knowledge: a document is built from a knowledge file. list_document_knowledge gives the list.');
    const basis = knowledge(knowledgeId);
    const now = Date.now();
    const doc: DocumentInfo = {
      id: old?.id ?? `${new Date(now).toISOString().slice(0, 10)}-${slug(title) || 'document'}-${randomBytes(2).toString('hex')}`,
      title,
      project: input.project === undefined ? old?.project ?? null : checkProject(input.project),
      knowledge: knowledgeId,
      kind: input.kind && DOCUMENT_KINDS.includes(input.kind) ? input.kind : old?.kind ?? basis.kind,
      summary: summaryOf(input.summary ?? old?.summary, text),
      created: old?.created ?? now,
      updated: now,
      version: (old?.version ?? 0) + 1,
      size: Buffer.byteLength(text),
      shared: old?.shared ?? null,
    };
    return { doc: write(doc, text), warnings: warningsFor(text) };
  }

  function patch(id: string, find: string, replacement: string): { doc: DocumentInfo; warnings: string[] } {
    const text = html(id);
    const first = text.indexOf(find);
    if (!find || first < 0) throw httpError(400, 'The document has no such fragment. read_document gives the current HTML.');
    if (text.indexOf(find, first + 1) >= 0) throw httpError(400, 'The fragment occurs more than once. Take a longer one.');
    const next = checkHtml(text.slice(0, first) + replacement + text.slice(first + find.length));
    const old = get(id);
    return { doc: write({ ...old, updated: Date.now(), version: old.version + 1, size: Buffer.byteLength(next) }, next), warnings: warningsFor(next) };
  }

  function share(id: string, url: string): DocumentInfo {
    if (!SHARE_URL.test(url)) throw httpError(400, 'url: a claude.ai link.');
    const doc = { ...get(id), shared: { url, at: Date.now() } };
    writeWhole(metaFile(id), JSON.stringify(doc, null, 1));
    return doc;
  }

  function remove(id: string): DocumentInfo {
    const doc = get(id);
    rmSync(htmlFile(id), { force: true });
    rmSync(metaFile(id), { force: true });
    texts.delete(id);
    return doc;
  }

  return { list, search, get, html, save, patch, share, remove, knowledgeList, knowledge, createKnowledge, saveKnowledge, removeKnowledge };
}

export const documentsFor = (ctx: Pick<Ctx, 'paths' | 'journal'>) => createDocuments(ctx.paths, (key) => ctx.journal.listProjects(true).some((p) => p.key === key));

// The composer writes «@document <id>»; older chat history has the Cyrillic token, which still means the same.
const DOCUMENT_MENTIONS = '«@document <id>» / «@документ <id>»'; // shippable-allow: chat history compatibility

// In the system prompt of every session: the tools are deferred, their descriptions are not seen until searched for.
export const DOCUMENT_RULE = `A report, documentation, a plan or a dashboard wanted as a document is a Claude OS document: start with list_document_knowledge. ${DOCUMENT_MENTIONS} in the user's message is a document: read it with read_document.`;

// Appended to the system prompt of a document's own tab: it costs nothing until the first message.
export const documentBrief = (id: string) => `This tab is open for the Claude OS document with id \`${id}\`. The user reads it next to this chat and asks for changes. read_document returns the current HTML, read_document_knowledge the document's basis. A small change: patch_document. A big one: read_document_knowledge first, then save_document with this id. The user sees the changes at once. Asked to change the template itself: edit the knowledge file through create_document_knowledge with replace: true. Answer briefly: what changed.`;

export function registerDocuments(ctx: Ctx): void {
  const { app } = ctx;
  const docs = documentsFor(ctx);
  type IdReq = { Params: { id: string } };

  app.get<{ Querystring: { q?: string } }>('/api/documents', async (req) => docs.search(req.query.q ?? ''));
  app.get<IdReq>('/api/documents/:id', async (req) => docs.get(req.params.id));
  // Opened by hand or framed, it is the same: the browser gives it no origin of the app and runs nothing in it.
  app.get<IdReq & { Querystring: { download?: string } }>('/api/documents/:id/html', async (req, reply) => {
    const doc = docs.get(req.params.id);
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', `sandbox; ${DOCUMENT_CSP}`)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    if (req.query.download) reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.id)}.html`);
    return docs.html(doc.id);
  });
  // One tab per document. Its session starts with the first message, so reading costs nothing.
  app.post<IdReq>('/api/documents/:id/tab', async (req) => {
    if (!ctx.chat) throw httpError(503, 'chat is not running');
    return ctx.chat.openDocument(docs.get(req.params.id));
  });
  app.delete<IdReq>('/api/documents/:id', async (req) => {
    const doc = docs.remove(req.params.id);
    ctx.chat?.closeDocument(doc.id);
    ctx.audit('documents.delete', doc.id, doc.title);
    ctx.invalidate('documents');
    return { ok: true };
  });

  app.get('/api/document-knowledge', async () => docs.knowledgeList());
  app.get<IdReq>('/api/document-knowledge/:id', async (req) => docs.knowledge(req.params.id));
  app.put<IdReq & { Body: { text?: string } }>('/api/document-knowledge/:id', async (req) => {
    const saved = docs.saveKnowledge(req.params.id, req.body?.text ?? '');
    ctx.audit('documents.knowledge', req.params.id);
    ctx.invalidate('documents');
    return saved;
  });
  app.delete<IdReq>('/api/document-knowledge/:id', async (req) => {
    docs.removeKnowledge(req.params.id);
    ctx.audit('documents.knowledge.delete', req.params.id);
    ctx.invalidate('documents');
    return { ok: true };
  });
}
