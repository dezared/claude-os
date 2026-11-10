import { ChevronDown, ChevronUp, History, Paperclip, Send, X } from 'lucide-react';
import { useState } from 'react';
import { spendNote } from '@/lib/account';
import { api, useApi } from '@/lib/api';
import { fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { toastError, useApp } from '@/lib/store';
import { createTab } from '@/lib/tabs';
import type { RecoveryItem } from '@/lib/types';
import { ProjectIcon } from './ProjectIcon';
import { Button, IconButton } from './ui';

const enc = encodeURIComponent;

function Item({ item, refetch }: { item: RecoveryItem; refetch: () => void }) {
  const { color, nameOf } = useProjectColors();
  const call = (path: string, method = 'POST') => api(path, { method }).then(refetch, toastError);
  // The tab's own conversation goes on with one message; a terminal session opens in a new tab and waits for the user's words.
  const go = async () => {
    if (item.kind === 'session') {
      if (await createTab({ resumeSessionId: item.sessionId, project: item.project ?? undefined, cwd: item.cwd })) refetch();
      return;
    }
    try {
      await api(`/api/tabs/${enc(item.tabId)}/send`, { method: 'POST', body: { text: t('recovery.prompt') } });
      useApp.getState().go(item.tabKind === 'root' ? { kind: 'home' } : { kind: 'tab', id: item.tabId });
      refetch();
    } catch (e) {
      toastError(e);
    }
  };
  const cut = item.kind === 'session' || item.interruptedAt !== null;
  const when = item.kind === 'session' ? item.lastActivity : item.interruptedAt;
  return (
    <li data-recovery={item.kind === 'tab' ? item.tabId : item.sessionId} className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-raised">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-soft">
        {item.project && <ProjectIcon project={item.project} name={nameOf(item.project)} color={color(item.project)} size={13} />}
        <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        {when !== null && <span className="flex-none text-[11px] text-dim tabular-nums">{fmtAgo(when)}</span>}
      </div>
      {cut && (
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{item.kind === 'session' ? t('recovery.terminal') : t('recovery.turnCut')}</span>
          <Button size="sm" title={spendNote()} onClick={() => void go()}>{t('recovery.continue')}</Button>
          <Button size="sm" title={t('recovery.closeHint')} onClick={() => void call(item.kind === 'session' ? `/api/recovery/sessions/${enc(item.sessionId)}/dismiss` : `/api/recovery/tabs/${enc(item.tabId)}/dismiss`)}>{t('recovery.close')}</Button>
        </div>
      )}
      {item.kind === 'tab' && item.queued.map((q) => (
        <div key={q.id} className="flex items-center gap-1 rounded border border-line2 py-0.5 pr-0.5 pl-2 text-[11.5px] text-muted">
          <span className="min-w-0 flex-1 truncate" title={q.text}>{q.text}</span>
          {q.attachments > 0 && <span title={t('recovery.attachments', { n: q.attachments })} className="flex flex-none items-center gap-0.5 text-dim"><Paperclip size={10} />{q.attachments}</span>}
          <IconButton label={t('recovery.send')} title={spendNote()} className="size-6 flex-none" onClick={() => void call(`/api/recovery/tabs/${enc(item.tabId)}/queue/${enc(q.id)}/send`)}><Send size={11} /></IconButton>
          <IconButton label={t('recovery.drop')} className="size-6 flex-none" onClick={() => void call(`/api/recovery/tabs/${enc(item.tabId)}/queue/${enc(q.id)}`, 'DELETE')}><X size={11} /></IconButton>
        </div>
      ))}
    </li>
  );
}

/** After a restart or a reboot: what was cut off, and one click to go on or to let it go. Nothing goes on by itself. */
export function RecoveryList() {
  const recovery = useApi<RecoveryItem[]>('/api/recovery', ['tabs', 'sessions']);
  const [open, setOpen] = useState(true);
  const items = recovery.data ?? [];
  if (items.length === 0) return null;
  return (
    <aside role="complementary" aria-label={t('recovery.aria')} className="glass-reading enter-fade absolute bottom-2 left-2 z-30 flex max-h-[50vh] w-[min(320px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl bg-[#0e0e12]!">
      <header className="flex flex-none items-center gap-2 py-1 pr-1 pl-3">
        <History size={13} className="flex-none text-accent" />
        <strong className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t('recovery.title')} · {items.length}</strong>
        <IconButton label={open ? t('recovery.hide') : t('recovery.show')} className="size-6" onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</IconButton>
      </header>
      {open && <ul className="min-h-0 overflow-auto border-t border-line2 p-1">{items.map((item) => <Item key={item.kind === 'tab' ? item.tabId : item.sessionId} item={item} refetch={recovery.refetch} />)}</ul>}
    </aside>
  );
}
