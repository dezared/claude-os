import { CloudUpload, Copy, Download, ExternalLink, FileCode2, Library, Menu, MessagesSquare, PanelRightClose, PanelRightOpen, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ErrorState, Skeleton } from '@/components/states';
import { StatusDot } from '@/components/StatusDot';
import { Button, Dialog, IconButton } from '@/components/ui';
import { ActionMenu, type MenuItem } from '@/home/ActionMenu';
import { api, useApi } from '@/lib/api';
import { emptyChat, useChat } from '@/lib/chat';
import { DOCUMENT_SANDBOX, KIND_ICON, KIND_LABEL, prepareDocument } from '@/lib/documents';
import { cn, fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { toast, toastError, useApp, usePersisted } from '@/lib/store';
import type { DocumentInfo, Tab } from '@/lib/types';
import { attachTab } from '@/lib/ws';
import { Composer } from '@/work/Composer';
import { SubagentStrip } from '@/work/SubagentStrip';
import { SubagentDialog } from '@/work/SubagentView';
import { Transcript } from '@/work/Transcript';
import { DeleteDialog } from './DeleteDialog';
import { KnowledgeDialog } from './KnowledgeDialog';

const htmlUrl = (id: string) => `/api/documents/${encodeURIComponent(id)}/html`;

/** The document itself. From a blob, not srcdoc: a srcdoc resolves "#part" against the app's address, and such a link would load the app into the frame. */
function Paper({ doc }: { doc: DocumentInfo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stale = false;
    setError(null);
    fetch(htmlUrl(doc.id), { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (stale) return;
        setReady(false);
        setSrc(URL.createObjectURL(new Blob([prepareDocument(text)], { type: 'text/html;charset=utf-8' })));
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [doc.id, doc.version]);
  useEffect(() => (src ? () => URL.revokeObjectURL(src) : undefined), [src]);
  if (error) return <div className="p-6"><ErrorState message={error} /></div>;
  if (src === null) return <Skeleton className="p-6" lines={10} />;
  return (
    <iframe
      data-testid="document-frame"
      title={doc.title}
      sandbox={DOCUMENT_SANDBOX}
      src={src}
      onLoad={() => setReady(true)}
      className={cn('block size-full border-0 bg-white transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0')}
    />
  );
}

/** Publishing leaves the machine, so it waits for a yes. The session does the work: only it has the claude.ai tools. */
function ExportDialog({ doc, onSend, onClose }: { doc: DocumentInfo; onSend: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('documents.exportTitle')} width={520}>
      <p className="mb-2 text-[13px] text-soft">{t('documents.exportBody', { title: doc.title })}</p>
      <p className="mb-3 text-xs text-muted">{t('documents.exportNote')}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={onSend}><CloudUpload size={13} />{t('documents.exportGo')}</Button>
      </div>
    </Dialog>
  );
}

function ChatPane({ tab, open }: { tab: Tab; open: boolean }) {
  const chat = useChat((s) => s.tabs[tab.id]) ?? emptyChat();
  const status = chat.status ?? tab.status;
  return (
    // Stays mounted while hidden: its stream goes on, and a question from Claude brings it back by itself.
    <aside
      data-testid="document-chat"
      aria-hidden={!open}
      inert={!open}
      className={cn('flex min-h-0 flex-none flex-col overflow-hidden border-line2 transition-[width,opacity,visibility] duration-200 ease-out', open ? 'visible w-[420px] border-l opacity-100' : 'invisible w-0 opacity-0')}
    >
      <div className="flex min-h-0 w-[420px] flex-1 flex-col">
        {chat.loaded ? (
          <Transcript
            chat={chat}
            tabId={tab.id}
            sessionId={chat.sessionId ?? tab.sessionId}
            scrollKey={tab.id}
            working={status === 'working'}
            small
            empty={<div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center text-muted"><MessagesSquare size={20} className="text-dim" />{t('documents.chatEmpty')}</div>}
          />
        ) : (
          <div className="flex-1 p-3"><Skeleton lines={6} /></div>
        )}
        <div className="flex-none px-2.5 pt-2 pb-2.5">
          <SubagentStrip sessionId={chat.sessionId ?? tab.sessionId} tasks={chat.tasks} className="mb-1.5 w-full" />
          <Composer tab={tab} chat={chat} placeholder={t('documents.chatPlaceholder')} />
        </div>
      </div>
    </aside>
  );
}

export function DocumentTab({ tab }: { tab: Tab }) {
  const id = tab.document!;
  const q = useApi<DocumentInfo>(`/api/documents/${encodeURIComponent(id)}`, ['documents']);
  const chat = useChat((s) => s.tabs[tab.id]);
  const status = chat?.status ?? tab.status;
  const [wanted, setWanted] = usePersisted('claude-os.document-chat', false);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'export' | 'knowledge' | null>(null);
  const { nameOf, color } = useProjectColors();
  const asked = tab.attention;
  const open = wanted || asked;
  const wasWorking = useRef(false);

  useEffect(() => {
    void attachTab(tab.id);
  }, [tab.id]);

  // Working with the chat hidden, the toggle's dot says so; its end says it too.
  useEffect(() => {
    if (wasWorking.current && status === 'idle' && !open) toast(t('documents.chatDone'));
    wasWorking.current = status === 'working';
  }, [status, open]);

  const doc = q.data;
  if (!doc) {
    return q.error
      ? <div className="p-6"><ErrorState message={q.error} onRetry={q.refetch} /></div>
      : <Skeleton className="p-6" lines={8} />;
  }

  const KindIcon = KIND_ICON[doc.kind];
  const send = async (text: string) => {
    setWanted(true);
    try {
      await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text } });
    } catch (e) {
      toastError(e);
    }
  };
  const items: MenuItem[] = [
    { id: 'documents.chat', label: t(open ? 'documents.chatHide' : 'documents.chatShow'), icon: open ? PanelRightClose : PanelRightOpen, onSelect: () => setWanted(!open) },
    { id: 'documents.knowledge', label: t('documents.openKnowledge'), icon: FileCode2, onSelect: () => setDialog('knowledge') },
    { id: 'documents.download', label: t('documents.download'), icon: Download, apart: true, onSelect: () => { window.location.href = `${htmlUrl(doc.id)}?download=1`; } },
    { id: 'documents.export', label: t(doc.shared ? 'documents.exportAgain' : 'documents.export'), icon: CloudUpload, onSelect: () => setDialog('export') },
    ...(doc.shared ? [
      { id: 'documents.shareOpen', label: t('documents.shareOpen'), icon: ExternalLink, onSelect: () => window.open(doc.shared!.url, '_blank', 'noopener') },
      { id: 'documents.shareCopy', label: t('documents.shareCopy'), icon: Copy, onSelect: () => void navigator.clipboard.writeText(doc.shared!.url).then(() => toast(t('documents.shareCopied')), toastError) },
    ] : []),
    { id: 'documents.library', label: t('documents.title'), icon: Library, apart: true, onSelect: () => useApp.getState().go({ kind: 'documents' }) },
    { id: 'documents.delete', label: t('documents.delete'), icon: Trash2, danger: true, apart: true, onSelect: () => setDialog('delete') },
  ];

  return (
    <ContextArea items={items} className="flex min-h-0 flex-1 flex-col">
      <div className="work-bar">
        <KindIcon size={14} className="flex-none text-dim" aria-label={t(KIND_LABEL[doc.kind])} />
        <strong className="min-w-0 truncate text-[13px] font-medium" title={doc.title}>{doc.title}</strong>
        {doc.project && (
          <button type="button" title={nameOf(doc.project)} onClick={() => useApp.getState().go({ kind: 'documents', project: doc.project })} className="press flex min-w-0 flex-none items-center gap-1.5 rounded px-1 text-[11px] text-muted hover:text-fg">
            <ProjectIcon project={doc.project} name={nameOf(doc.project)} color={color(doc.project)} size={13} />
            <span className="max-w-40 truncate">{nameOf(doc.project)}</span>
          </button>
        )}
        <span className="flex-none text-[11px] whitespace-nowrap text-dim">{t('documents.updated', { ago: fmtAgo(doc.updated) })}</span>
        <span className="flex-1" />
        {doc.shared && (
          <a href={doc.shared.url} target="_blank" rel="noopener noreferrer" title={doc.shared.url} className="press flex flex-none items-center gap-1 rounded px-1.5 text-[11px] text-muted hover:text-fg">
            <CloudUpload size={12} />{t('documents.shared')}
          </a>
        )}
        <Button className="flex-none" aria-pressed={open} onClick={() => setWanted(!open)}>
          {status !== 'idle' && status !== 'ended' ? <StatusDot status={status} attention={tab.attention} /> : open ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
          {t('documents.edit')}
        </Button>
        <ActionMenu
          label={t('documents.menu')}
          side="bottom"
          align="end"
          open={menu}
          onOpenChange={setMenu}
          items={items}
          trigger={<IconButton label={t('documents.menu')} aria-haspopup="menu" aria-expanded={menu}><Menu size={14} /></IconButton>}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 bg-white">
          <Paper doc={doc} />
        </div>
        <ChatPane tab={tab} open={open} />
      </div>
      <SubagentDialog />
      {dialog === 'delete' && <DeleteDialog doc={doc} onClose={() => setDialog(null)} onDeleted={() => { useApp.getState().go({ kind: 'documents' }); useApp.getState().forgetTab(tab.id); }} />}
      {dialog === 'knowledge' && <KnowledgeDialog id={doc.knowledge} onClose={() => setDialog(null)} />}
      {dialog === 'export' && (
        <ExportDialog
          doc={doc}
          onClose={() => setDialog(null)}
          onSend={() => {
            setDialog(null);
            void send(t('documents.exportPrompt', { id: doc.id }));
          }}
        />
      )}
    </ContextArea>
  );
}
