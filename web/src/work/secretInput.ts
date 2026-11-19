// The value typed after /secret lives only here: the field, its draft, its undo and the paste store only ever hold dots
// (shared/secrets.ts). On send it goes to the server by its own route, never as a chat message.
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { toast, toastError } from '@/lib/store';
import type { Attachment } from '../../../shared/contract.ts';
import { editField, maskField, SECRET_MASK, SECRET_PREFIX, secretLines } from '../../../shared/secrets.ts';
import { expandPastes } from './pastes';

export function useSecretField(field: RefObject<HTMLTextAreaElement | null>) {
  const raw = useRef('');
  const caret = useRef<number | null>(null);
  // React puts the caret at the end when it writes a value the field did not have: here the dots that replaced the typed text.
  useLayoutEffect(() => {
    if (caret.current === null) return;
    field.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  // A text set from elsewhere (a draft, a sent message) is the real one; dots in it stand for nothing.
  const real = (shown: string) => (maskField(raw.current) === shown ? raw.current : shown);
  return {
    /** The field's new text after an input event: the real text is kept here, the field gets its mask. */
    edit(shown: string, next: string, at: number): string {
      const edited = editField(real(shown), shown, next, at);
      if (edited === null) {
        toast(t('composer.secretOneLine'), 'error');
        return shown;
      }
      raw.current = edited;
      const masked = maskField(raw.current);
      if (masked !== next) caret.current = at;
      return masked;
    },
    /**
     * Sends what the field shows; true once the server has it and the field may empty. A field that is one `/secret`
     * line sends just the value; a message with `/secret` lines goes whole, and the server puts markers in their place.
     */
    async submit(tabId: string, shown: string, attachments: Attachment[]): Promise<boolean> {
      const full = real(shown).trimEnd();
      const lines = secretLines(full);
      const problem = lines.length === 0 || lines.some((l) => !l.value) ? 'composer.secretUsage' : lines.some((l) => l.value.includes(SECRET_MASK)) ? 'composer.secretRetype' : null;
      if (problem) {
        toast(t(problem), 'error');
        return false;
      }
      const alone = full.startsWith(SECRET_PREFIX) && !full.includes('\n') && attachments.length === 0;
      const body = alone ? { name: lines[0].name, value: lines[0].value } : { text: expandPastes(tabId, full), attachments: attachments.length ? attachments : undefined };
      try {
        await api(`/api/tabs/${encodeURIComponent(tabId)}/secret`, { method: 'POST', body });
        raw.current = '';
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
  };
}
