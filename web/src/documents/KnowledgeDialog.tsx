import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Dialog, Textarea } from '@/components/ui';
import { api, invalidateTopics, useApi } from '@/lib/api';
import { locale, t } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { toast, toastError } from '@/lib/store';
import type { DocumentKnowledge } from '@/lib/types';
import { knowledgeLabel } from '../../../shared/documents.ts';

const url = (id: string) => `/api/document-knowledge/${encodeURIComponent(id)}`;

/** A knowledge file: read as Markdown, changed by hand or by Claude. A shipped one is never overwritten: the change goes to config/. */
export function KnowledgeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApi<DocumentKnowledge>(url(id), ['documents']);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(null), [id]);
  const k = q.data;
  const label = k && knowledgeLabel(k, locale());

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      invalidateTopics(['documents']);
      toast(done);
      setDraft(null);
    } catch (e) {
      toastError(e);
    }
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={label?.name ?? id} description={label?.description} width={820}>
      {!k ? (
        q.error ? <ErrorState message={q.error} onRetry={q.refetch} /> : <Skeleton lines={8} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[11px] wrap-anywhere text-dim">{k.path}</p>
          {draft === null ? (
            <Markdown text={k.text.replace(/^---[\s\S]*?\n---\s*/, '')} className="selectable" />
          ) : (
            <Textarea aria-label={t('documents.knowledgeText')} autoFocus rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-xs leading-[1.55]" />
          )}
          <div className="sticky -bottom-4 -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-line2 bg-[#141416] px-4 py-2.5">
            {draft === null ? (
              <>
                {k.builtin && k.customized && (
                  <Button disabled={busy} className="mr-auto" onClick={() => void run(() => api(url(id), { method: 'DELETE' }), t('documents.knowledgeRestored'))}>
                    <RotateCcw size={12} />{t('documents.knowledgeRestore')}
                  </Button>
                )}
                <Button
                  onClick={() => askClaude({
                    subject: { kind: 'document knowledge file', name: k.name, context: `Id: ${k.id}\nChange it with read_document_knowledge and create_document_knowledge (replace: true).` },
                    intent: 'change',
                    title: t('documents.knowledgeAskTitle', { name: label!.name }),
                    placeholder: t('documents.knowledgeAskPlaceholder'),
                  })}
                >
                  {t('claude.change')}
                </Button>
                <Button variant="primary" onClick={() => setDraft(k.text)}>{t('documents.knowledgeEdit')}</Button>
              </>
            ) : (
              <>
                <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
                <Button variant="primary" disabled={busy || !draft.trim()} onClick={() => void run(() => api(url(id), { method: 'PUT', body: { text: draft } }), t('documents.knowledgeSaved'))}>{t('documents.knowledgeSave')}</Button>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
