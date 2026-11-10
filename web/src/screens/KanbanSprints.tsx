import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { Button, Dialog, Field, Input, Segmented } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { api, invalidateTopics } from '@/lib/api';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { KanbanSprint } from '@/lib/types';

const URL = '/api/kanban/sprints';

/** What the board asks of a sprint: a new one from the board menu, a rename or a removal from its segment's menu. */
export type SprintEdit = { kind: 'new' } | { kind: 'rename' | 'delete'; sprint: KanbanSprint };

/** The switcher over the board, only when there are sprints. Right click on a sprint renames or removes it. */
export function SprintSwitcher({ sprints, value, onChange, onEdit, all, none }: { sprints: KanbanSprint[]; value: string; onChange: (v: string) => void; onEdit: (edit: SprintEdit) => void; all: string; none: string }) {
  if (sprints.length === 0) return null;
  // The segments go "all", the sprints in order, "no sprint": the clicked one's place names the sprint.
  const items = (e: MouseEvent): MenuItem[] | null => {
    const radio = (e.target as Element).closest('[role="radio"]');
    const sprint = radio?.parentElement ? sprints[[...radio.parentElement.children].indexOf(radio) - 1] : undefined;
    if (!sprint) return null;
    return [
      { id: 'kanban.sprintRename', label: t('kanban.sprintRename'), icon: Pencil, onSelect: () => onEdit({ kind: 'rename', sprint }) },
      { id: 'kanban.sprintDelete', label: t('kanban.sprintDelete'), icon: Trash2, danger: true, onSelect: () => onEdit({ kind: 'delete', sprint }) },
    ];
  };
  return (
    <div className="flex flex-none items-center gap-2 overflow-x-auto px-3 pt-3">
      <ContextArea items={items}>
        <Segmented
          ariaLabel={t('kanban.sprint')}
          value={value}
          onChange={onChange}
          options={[{ value: all, label: t('kanban.sprintAll') }, ...sprints.map((x) => ({ value: x.id, label: x.name })), { value: none, label: t('kanban.sprintNone') }]}
        />
      </ContextArea>
    </div>
  );
}

async function run(busy: (on: boolean) => void, onClose: () => void, request: () => Promise<unknown>) {
  busy(true);
  try {
    await request();
    invalidateTopics(['kanban']);
    onClose();
  } catch (e) {
    toastError(e);
    busy(false);
  }
}

/** A sprint's name for a new one or a rename, or the confirmation of a removal: its cards stay, with no sprint. */
export function SprintDialog({ edit, onClose }: { edit: SprintEdit; onClose: () => void }) {
  const [name, setName] = useState(edit.kind === 'new' ? '' : edit.sprint.name);
  const [busy, setBusy] = useState(false);
  if (edit.kind === 'delete') {
    const remove = () => run(setBusy, onClose, () => api(`${URL}/${encodeURIComponent(edit.sprint.id)}`, { method: 'DELETE' }));
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title={t('kanban.sprintDeleteTitle', { name: edit.sprint.name })} description={t('kanban.sprintDeleteHint')}>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}><Trash2 size={13} /> {t('kanban.sprintDelete')}</Button>
        </div>
      </Dialog>
    );
  }
  const save = () => {
    if (!name.trim() || busy) return;
    const body = { name: name.trim() };
    void run(setBusy, onClose, () => (edit.kind === 'new' ? api(URL, { method: 'POST', body }) : api(`${URL}/${encodeURIComponent(edit.sprint.id)}`, { method: 'PATCH', body })));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t(edit.kind === 'new' ? 'kanban.sprintNew' : 'kanban.sprintRenameTitle')}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label={t('kanban.sprintName')}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>{t(edit.kind === 'new' ? 'kanban.create' : 'kanban.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
