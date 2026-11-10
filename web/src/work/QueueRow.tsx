import { Pencil, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '@/components/ui';
import { api } from '@/lib/api';
import type { ChatState } from '@/lib/chat';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import { keepPastedTags, stripPastedTags } from '../../../shared/pasted.ts';

/** The text of a queued message being edited: mounted fresh each time, so it starts from the stored text. Enter saves, Shift+Enter breaks the line, Escape drops the edit. */
function QueueEditor({ text, onSave, onCancel }: { text: string; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  return (
    <textarea
      autoFocus
      aria-label={t('composer.queueEditAria')}
      rows={Math.min(value.split('\n').length, 6)}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSave(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSave(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="min-w-0 flex-1 resize-none bg-transparent py-0.5 text-soft outline-none"
    />
  );
}

/** A message waiting in the tab's queue: send it now, edit or remove it. */
export function QueueRow({ tabId, item, editing, setEditing }: { tabId: string; item: ChatState['queue'][number]; editing: boolean; setEditing: (on: boolean) => void }) {
  const raw = item.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
  const text = stripPastedTags(raw);
  const path = `/api/tabs/${encodeURIComponent(tabId)}/queue/${encodeURIComponent(item.id ?? '')}`;
  const call = (suffix: string, method: 'PATCH' | 'DELETE' | 'POST', body?: unknown) => api(path + suffix, { method, body }).catch(toastError);
  // The row edits the text without the paste tags; an unchanged text is not sent, a changed one gets them back
  // around the pasted blocks it left as they were, so they stay folded.
  const save = async (value: string) => {
    setEditing(false);
    if (value.trim() !== text.trim()) await call('', 'PATCH', { text: keepPastedTags(raw, value.trim()) });
  };
  return (
    <div className="enter-fade flex items-center gap-1 rounded-md border border-dashed border-line py-0.5 pr-0.5 pl-2.5 text-xs text-muted">
      {editing ? (
        <QueueEditor text={text} onSave={(v) => void save(v)} onCancel={() => setEditing(false)} />
      ) : (
        <span className="min-w-0 flex-1 truncate py-0.5" title={text}>{text || t('chat.attachment')}</span>
      )}
      {item.id && !editing && (
        <>
          <IconButton label={t('composer.queueSendNow')} className="size-6" onClick={() => void call('/send', 'POST')}><Zap size={11} /></IconButton>
          <IconButton label={t('composer.queueEdit')} className="size-6" onClick={() => setEditing(true)}><Pencil size={11} /></IconButton>
          <IconButton label={t('composer.queueRemove')} className="size-6" onClick={() => void call('', 'DELETE')}><X size={11} /></IconButton>
        </>
      )}
    </div>
  );
}
