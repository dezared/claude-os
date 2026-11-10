import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useMemo } from 'react';
import { cn } from '@/lib/format';

marked.setOptions({ gfm: true, breaks: false });

// Logs and notes are data: raw HTML is sanitized, links open outside the app window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

export const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'video', 'audio'],
  FORBID_ATTR: ['style'],
};

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), SANITIZE);
}

/** A tooltip shows whatever a title holds, a skill's description or a session's name: nothing in it may load from the network. */
export function renderTipMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), { ...SANITIZE, FORBID_TAGS: [...SANITIZE.FORBID_TAGS, 'img'] });
}

export const Markdown = memo(function Markdown({ text, small, className }: { text: string; small?: boolean; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={cn('md', small && 'md-sm', className)} dangerouslySetInnerHTML={{ __html: html }} />;
});
