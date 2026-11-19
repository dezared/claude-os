import { useEffect, useState } from 'react';
import { DOCUMENT_SANDBOX, prepareDocument } from '@/lib/documents';
import { cn } from '@/lib/format';

/**
 * HTML a plugin was given (by Claude, say) in the frame documents use: no scripts, no app origin, links leave for the browser.
 * From a blob, not srcdoc, for the reason in DocumentTab's Paper. It fades in once loaded, so a change of page does not flash.
 */
export function HtmlFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([prepareDocument(html)], { type: 'text/html;charset=utf-8' }));
    setReady(false);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);
  if (src === null) return null;
  return (
    <iframe
      title={title}
      data-testid="html-frame"
      sandbox={DOCUMENT_SANDBOX}
      src={src}
      onLoad={() => setReady(true)}
      className={cn('block border-0 transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0', className)}
    />
  );
}
