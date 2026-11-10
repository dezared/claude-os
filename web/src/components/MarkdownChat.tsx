import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import type { Tab } from '../../../shared/contract.ts';
import { documentIdFromLink } from '../../../shared/documents.ts';
import { peekCached } from '@/lib/api';
import { openDocument } from '@/lib/documents';
import { findPaths, imageUrl, isImagePath, displayPath } from '@/lib/filePaths';
import { cn } from '@/lib/format';
import { highlightCode } from '@/lib/highlight';
import { t } from '@/lib/i18n';
import { openImage, openPath } from '@/work/FileViewer';
import { SANITIZE } from './Markdown';

const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const name = lang?.trim().split(/\s+/)[0];
      const html = highlightCode(text, name);
      if (html === null) return false; // marked's own escaped block
      return `<pre><code class="hljs">${html}</code></pre>\n`;
    },
  },
});

function pathLink(doc: Document, path: string, line: number | null, label: string): HTMLAnchorElement {
  const a = doc.createElement('a');
  a.href = '#file';
  a.className = 'file-link';
  a.dataset.file = path;
  if (line !== null) a.dataset.line = String(line);
  a.title = path;
  a.textContent = label;
  return a;
}

function inlineImage(doc: Document, tabId: string, path: string): HTMLImageElement {
  const img = doc.createElement('img');
  img.src = imageUrl(tabId, path);
  img.alt = path;
  img.loading = 'lazy';
  img.className = 'chat-img';
  return img;
}

/** Links for paths and pictures for images. On the DOM, not on the markdown: what is already a link or a code block stays as it is. */
function decorate(root: DocumentFragment, tabId: string, cwd: string | null, images: boolean): void {
  const doc = root.ownerDocument;
  const seen = new Set<string>();
  const image = (path: string, after: Node) => {
    if (!images || !isImagePath(path) || seen.has(path)) return;
    seen.add(path);
    after.parentNode?.insertBefore(inlineImage(doc, tabId, path), after.nextSibling);
  };

  // [a.ts](src/a.ts): a link to a file, not a page the browser would go to.
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')!;
    if (/^([a-z][a-z\d+.-]*:|#|\/\/)/i.test(href) || documentIdFromLink(href)) continue;
    let path: string;
    try {
      path = decodeURI(href);
    } catch {
      continue;
    }
    const [f] = findPaths(path);
    if (!f || f.length !== path.length) continue;
    const text = link.textContent ?? '';
    const a = pathLink(doc, f.path, f.line, text === path ? displayPath(f.path, cwd) + path.slice(f.path.length) : '');
    if (text !== path) a.append(...link.childNodes);
    link.replaceWith(a);
  }

  const texts: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, code, pre')) texts.push(node);
  }
  for (const node of texts) {
    const found = findPaths(node.data);
    if (found.length === 0) continue;
    const parts = doc.createDocumentFragment();
    const after: { path: string; node: Node }[] = [];
    let at = 0;
    for (const f of found) {
      parts.append(node.data.slice(at, f.index));
      const a = pathLink(doc, f.path, f.line, displayPath(f.path, cwd) + node.data.slice(f.index + f.path.length, f.index + f.length));
      parts.append(a);
      after.push({ path: f.path, node: a });
      at = f.index + f.length;
    }
    parts.append(node.data.slice(at));
    node.replaceWith(parts);
    for (const x of after) image(x.path, x.node);
  }

  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const text = code.textContent ?? '';
    const [f] = findPaths(text);
    if (!f || f.length !== text.length) continue;
    const a = pathLink(doc, f.path, f.line, '');
    code.textContent = displayPath(f.path, cwd) + text.slice(f.path.length);
    code.replaceWith(a);
    a.append(code);
    image(f.path, a);
  }

  // ![alt](screens/a.png): the browser cannot reach the disk on its own.
  for (const img of root.querySelectorAll('img')) {
    if (img.classList.contains('chat-img')) continue;
    const src = img.getAttribute('src') ?? '';
    if (/^(https?:|data:|\/api\/)/.test(src)) continue;
    const path = decodeURI(src);
    if (!isImagePath(path) || !images) {
      img.remove();
      continue;
    }
    img.src = imageUrl(tabId, path);
    img.loading = 'lazy';
    img.className = 'chat-img';
  }
}

// Coming back to a long chat would parse, highlight and sanitize every reply again: over a second on the main thread.
const CACHE_LIMIT = 600;
const rendered = new Map<string, string>();

function cachedRender(text: string, tabId: string | null, cwd: string | null, images: boolean): string {
  if (!images) return render(text, tabId, cwd, images); // a stream: this text is never asked for twice
  const key = `${tabId}\n${cwd}\n${text}`;
  const known = rendered.get(key);
  if (known !== undefined) return known;
  const html = render(text, tabId, cwd, images);
  if (rendered.size >= CACHE_LIMIT) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, html);
  return html;
}

function render(text: string, tabId: string | null, cwd: string | null, images: boolean): string {
  const fragment = DOMPurify.sanitize(parser.parse(text, { async: false }), { ...SANITIZE, ADD_ATTR: ['loading'], RETURN_DOM_FRAGMENT: true });
  if (tabId) decorate(fragment, tabId, cwd, images);
  const out = document.createElement('template'); // inert: no picture starts loading before it is on screen
  out.content.append(fragment);
  return out.innerHTML;
}

/**
 * A reply in the chat: highlighted code, paths that open, images in place. `tabId` is whose files the paths mean.
 * While a reply is still streaming `images` stays off: every frame replaces the HTML, a picture would blink.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, small, tabId, images = true }: { text: string; small?: boolean; tabId: string | null; images?: boolean }) {
  // Paths inside it read relative. Peeked, not subscribed: the tab list is loaded before its chat, and every reply re-rendering on each tabs change would cost more.
  const cwd = (tabId && peekCached<Tab[]>('/api/tabs')?.find((x) => x.id === tabId)?.cwd) || null;
  const html = useMemo(() => cachedRender(text, tabId, cwd, images), [text, tabId, cwd, images]);
  const box = useRef<HTMLDivElement>(null);

  // A path in the text that names no file yet ("will be saved as a.png") is not a broken picture. Errors do not bubble: capture.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onError = (e: Event) => {
      if (e.target instanceof HTMLImageElement) e.target.hidden = true;
    };
    el.addEventListener('error', onError, true);
    return () => el.removeEventListener('error', onError, true);
  }, []);

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element;
    const documentId = documentIdFromLink(target.closest('a')?.getAttribute('href') ?? '');
    if (documentId) {
      e.preventDefault();
      void openDocument(documentId);
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[data-file]');
    if (link && tabId) {
      e.preventDefault();
      openPath(tabId, link.dataset.file!, link.dataset.line ? Number(link.dataset.line) : null);
      return;
    }
    if (target instanceof HTMLImageElement) openImage(target.src, target.alt || t('chat.imageAlt'));
  };

  return <div ref={box} onClick={onClick} className={cn('md', small && 'md-sm')} dangerouslySetInnerHTML={{ __html: html }} />;
});
