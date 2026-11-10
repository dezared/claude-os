import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { toast, toastError } from '@/lib/store';
import type { DocumentInfo } from '@/lib/types';

export function DeleteDialog({ doc, onClose, onDeleted }: { doc: DocumentInfo; onClose: () => void; onDeleted?: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('documents.deleteTitle')}>
      <p className="mb-3 text-[13px] wrap-anywhere text-soft">{doc.title}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
              toast(t('documents.deleted'));
              onClose();
              onDeleted?.();
            } catch (e) {
              toastError(e);
              setBusy(false);
            }
          }}
        >
          <Trash2 size={13} /> {t('documents.delete')}
        </Button>
      </div>
    </Dialog>
  );
}
