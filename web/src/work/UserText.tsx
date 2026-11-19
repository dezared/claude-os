// What the user wrote, as the bubble shows it: long pastes folded (see pastes.ts), /secret markers as a lock and the name.
import { Lock } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { PASTED_BLOCK } from '../../../shared/pasted.ts';
import { SECRET_MARKER } from '../../../shared/secrets.ts';

// A long paste goes out in a tag (see pastes.ts): in the bubble it is a block of its own, folded to a few lines.
function PastedBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure); // the column can change width: /view
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  return (
    <span data-testid="pasted-block" className="my-1 block rounded-md border border-line px-2.5 py-1.5 text-[13px] text-soft">
      <span ref={body} className={open ? 'block' : 'line-clamp-6'}>{text}</span>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="press mt-1 text-[11px] text-dim select-none hover:text-fg">
          {t(open ? 'chat.pasteCollapse' : 'chat.pasteExpand')}
        </button>
      )}
    </span>
  );
}

export function withPastes(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(PASTED_BLOCK)) {
    parts.push(withSecrets(text.slice(at, m.index)), <PastedBlock key={m.index} text={m[1]} />);
    at = m.index + m[0].length;
  }
  return at === 0 ? withSecrets(text) : [...parts, withSecrets(text.slice(at))];
}

// The marker a /secret leaves in the conversation (shared/secrets.ts): the value was never here.
function withSecrets(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(SECRET_MARKER)) {
    parts.push(
      text.slice(at, m.index),
      <span key={m.index} data-testid="secret-chip" title={t('chat.secretChip')} className="inline-flex items-center gap-1 rounded-sm bg-accent-bg px-1.5 align-baseline font-mono text-[12px] ring-1 ring-accent-deep/50">
        <Lock size={11} className="flex-none" />
        {m[1]}
      </span>,
    );
    at = m.index + m[0].length;
  }
  return at === 0 ? text : [...parts, text.slice(at)];
}
