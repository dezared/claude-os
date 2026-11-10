import { AppWindow, CircleAlert, CircleCheck, Hourglass, MessageCircleQuestionMark, MessagesSquare, Minus, Square, SquareKanban, X, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { serverText, t } from '@/lib/i18n';
import { toast, toastError, useApp } from '@/lib/store';
import { createTab } from '@/lib/tabs';
import type { Project, ServiceTask, ServiceTaskStatus, Tab } from '@/lib/types';
import { popoutBridge, usePopouts } from './desktop';
import { Markdown } from './Markdown';
import { Button, Dialog, IconButton, Textarea } from './ui';

const LOOK = {
  queued: { icon: Hourglass, tone: 'text-dim', label: 'service.queued' },
  running: { icon: Zap, tone: 'text-accent', label: 'service.running' },
  question: { icon: MessageCircleQuestionMark, tone: 'text-warn', label: 'service.question' },
  done: { icon: CircleCheck, tone: 'text-ok', label: 'service.done' },
  failed: { icon: CircleAlert, tone: 'text-bad', label: 'service.failed' },
} as const satisfies Record<ServiceTaskStatus, { icon: LucideIcon; tone: string; label: string }>;

const url = (task: ServiceTask, action = '') => `/api/service/tasks/${encodeURIComponent(task.id)}${action}`;

/** The panel of the main window: shown by the title bar's button, hidden by the owner, never in the way of a click elsewhere.
 * `unseen`: an answer came while it was hidden; the button marks it until the panel is opened. */
const useServicePanel = create<{ open: boolean; unseen: boolean }>(() => ({ open: false, unseen: false }));
const showPanel = () => useServicePanel.setState({ open: true, unseen: false });
const OUT = 'service';

/** The work goes on where the owner can talk to it: a new tab in the task's project, or in the root's folder. */
async function continueInTab(task: ServiceTask) {
  const project = task.project ? (await api<Project[]>('/api/projects')).find((p) => p.key === task.project) : undefined;
  const cwd = project?.root ?? (await api<Tab[]>('/api/tabs')).find((x) => x.kind === 'root')?.cwd;
  if (!cwd) return toast(t('service.noFolder'), 'error');
  const prompt = `Continue the task "${task.title}". The service session already worked on it, its answer:\n\n${task.answer ?? ''}`;
  const tab = await createTab({ cwd, title: task.title });
  if (!tab) return; // createTab said why; the panel stays with the answer
  useServicePanel.setState({ open: false });
  await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: prompt } });
}

function Card({ task, embedded }: { task: ServiceTask; embedded?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { icon: Icon, tone, label } = LOOK[task.status];
  const live = task.status === 'queued' || task.status === 'running';

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  const answer = () => text.trim() && act(() => api(url(task, '/answer'), { method: 'POST', body: { text: text.trim() } }));

  return (
    <div data-testid="service-task" data-status={task.status} className={embedded ? 'enter-fade' : 'enter-fade rounded-xl border border-line bg-[#141418] p-3'}>
      <div className="flex items-start gap-2">
        <Icon size={14} className={cn('mt-0.5 flex-none', tone, task.status === 'running' && 'dot-working')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-fg" title={task.title}>{task.title}</div>
          <div className={cn('text-xs', tone)}>{t(embedded && task.status === 'question' ? 'service.questionRound' : label)}</div>
        </div>
        {!embedded && (live ? (
          <IconButton label={t('service.stop')} className="size-6 flex-none" disabled={busy} onClick={() => act(() => api(url(task, '/interrupt'), { method: 'POST' }))}>
            <Square size={11} />
          </IconButton>
        ) : (
          <IconButton label={t('service.close')} className="size-6 flex-none" onClick={() => act(() => api(url(task), { method: 'DELETE' }))}>
            <X size={12} />
          </IconButton>
        ))}
      </div>
      {task.questions ? (
        <div className="mt-2 flex flex-col gap-2">
          <ol className="selectable list-decimal pl-5 text-[13px] text-soft">
            {task.questions.map((q) => <li key={q}>{q}</li>)}
          </ol>
          <Textarea
            autoFocus
            rows={3}
            value={text}
            placeholder={t('service.answerPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void answer();
            }}
          />
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void answer()}>{t('service.answer')}</Button>
          </div>
        </div>
      ) : task.answer && !live && (
        <div className="selectable mt-2 max-h-72 overflow-auto text-[13px] wrap-anywhere text-soft"><Markdown text={task.answer} /></div>
      )}
      {task.error && <p role="alert" className="selectable mt-2 text-xs wrap-anywhere text-bad">{serverText(task.error, task.errorKey, task.errorParams)}</p>}
      <CardFooter task={task} embedded={embedded} busy={busy} act={act} />
    </div>
  );
}

/** What is left to do with a task that is over: try a failed one again, take a done one on in a tab. */
function CardFooter({ task, embedded, busy, act }: { task: ServiceTask; embedded?: boolean; busy: boolean; act: (run: () => Promise<unknown>) => Promise<void> }) {
  if (task.status === 'failed') {
    return (
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={busy} onClick={() => act(() => api(url(task, '/retry'), { method: 'POST' }))}>{t('service.retry')}</Button>
      </div>
    );
  }
  if (task.status !== 'done' || embedded || task.continuable === false) return null;
  return (
    <div className="mt-2 flex justify-end">
      <Button size="sm" disabled={busy} onClick={() => act(() => continueInTab(task))}><MessagesSquare size={12} />{t('service.continueTab')}</Button>
    </div>
  );
}

function useListed() {
  const data = useApi<ServiceTask[]>('/api/service/tasks', ['service']).data;
  return { tasks: (data ?? []).filter((task) => !task.modal), loaded: data !== undefined };
}
const active = (task: ServiceTask) => task.status === 'queued' || task.status === 'running' || task.status === 'question';

/** The queue, newest first: the panel's body and the whole of its separate window. */
export function ServiceTaskList() {
  const { tasks } = useListed();
  if (tasks.length === 0) return <p className="p-3 text-xs text-dim">{t('service.empty')}</p>;
  return <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2">{tasks.map((task) => <Card key={task.id} task={task} />)}</div>;
}

/** In the title bar: there while there are tasks or their window is out. The number is what is going on or waiting for the owner. */
export function ServiceTasksButton() {
  const { tasks } = useListed();
  const { open, unseen } = useServicePanel();
  const out = usePopouts((s) => s.keys.includes(OUT));
  if (tasks.length === 0 && !out) return null;
  const count = tasks.filter(active).length;
  const asking = tasks.some((task) => task.status === 'question');
  const working = tasks.some((task) => task.status === 'running');
  return (
    <button
      type="button"
      aria-label={t('service.region')}
      aria-pressed={open && !out}
      title={t('service.region')}
      onClick={() => (out ? popoutBridge()?.openPopout({ kind: 'service' }) : open ? useServicePanel.setState({ open: false }) : showPanel())}
      className={cn('press flex h-7 items-center gap-1 rounded-md px-2', open && !out ? 'bg-white/[.12] text-fg' : 'text-muted hover:bg-white/[.08] hover:text-fg')}
    >
      <Zap size={13} className={cn(asking ? 'text-warn' : working && 'dot-working text-accent')} />
      {count > 0 && <span className={cn('font-mono text-[11px]', asking && 'text-warn')}>{count}</span>}
      {unseen && !out && <span role="status" aria-label={t('service.newAnswer')} className="size-1.5 flex-none rounded-full bg-ok" />}
      {out && <AppWindow size={11} aria-label={t('popout.isOut')} className="flex-none text-accent" />}
    </button>
  );
}

/** A task just started or a question asked comes up by itself: the owner waits for it, or the task waits for the owner.
 * An answer only marks the button: it can wait to be read. */
function react(before: Map<string, ServiceTaskStatus>, now: Map<string, ServiceTaskStatus>) {
  const entered = (status: ServiceTaskStatus) => [...now].some(([id, s]) => s === status && before.get(id) !== status);
  const out = usePopouts.getState().keys.includes(OUT);
  if (entered('question') && out) popoutBridge()?.openPopout({ kind: 'service' });
  else if (!out && (entered('question') || [...now.keys()].some((id) => !before.has(id)))) showPanel();
  else if (!out && entered('done') && !useServicePanel.getState().open) useServicePanel.setState({ unseen: true });
}

/** Mounted once. What the hidden service session is doing for the user and what it answered: nothing else on screen shows it. */
export function ServiceTasks() {
  const { tasks, loaded } = useListed();
  const open = useServicePanel((s) => s.open);
  const out = usePopouts((s) => s.keys.includes(OUT));
  const windows = popoutBridge();
  const seen = useRef<Map<string, ServiceTaskStatus> | null>(null);
  const states = tasks.map((task) => `${task.id}:${task.status}`).join(' ');
  useEffect(() => {
    if (!loaded) return; // what was there before this page loaded is not news
    const now = new Map(states ? states.split(' ').map((s) => s.split(':') as [string, ServiceTaskStatus]) : []);
    if (seen.current) react(seen.current, now);
    seen.current = now;
  }, [states, loaded]);
  return (
    <>
    <ModalServiceTasks boardLink />
    {open && !out && tasks.length > 0 && (
      <aside role="complementary" aria-label={t('service.region')} className="glass-reading enter-fade fixed top-12 right-2 z-40 flex max-h-[calc(100vh-4rem)] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl bg-[#0e0e12]!">
        <header className="flex flex-none items-center gap-2 border-b border-line2 py-1 pr-1 pl-3">
          <Zap size={13} className="flex-none text-accent" />
          <strong className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t('service.region')}</strong>
          {windows && (
            <IconButton label={t('service.popout')} className="size-6" onClick={() => windows.openPopout({ kind: 'service' })}><AppWindow size={13} /></IconButton>
          )}
          <IconButton label={t('service.hide')} className="size-6" onClick={() => useServicePanel.setState({ open: false })}><Minus size={13} /></IconButton>
        </header>
        <ServiceTaskList />
      </aside>
    )}
    </>
  );
}

/** The same card in a dialog that stays: closing it while the job is alive means interrupting it, and it asks. */
function TaskDialog({ task, boardLink }: { task: ServiceTask; boardLink?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const over = task.status === 'done' || task.status === 'failed';
  const finish = async (action: string, method: 'POST' | 'DELETE') => {
    setBusy(true);
    try {
      await api(url(task, action), { method });
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && (over ? void finish('', 'DELETE') : setAsking(true))} title={t('service.modalTitle')} description={t('service.modalHint')} width={560}>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        <Card task={task} embedded />
        {asking && (
          <div role="alert" className="enter-fade flex flex-wrap items-center gap-2 rounded-lg border border-accent-deep bg-accent-bg px-3 py-2 text-xs text-soft">
            <span className="min-w-0 flex-1">{t('service.interruptAsk')}</span>
            <Button size="sm" onClick={() => setAsking(false)}>{t('service.keepWorking')}</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void finish('/interrupt', 'POST')}>{t('service.interrupt')}</Button>
          </div>
        )}
        {over && (
          <div className="flex justify-end gap-2">
            {boardLink && task.status === 'done' && (
              <Button onClick={() => {
                useApp.getState().go({ kind: 'kanban', board: task.link });
                void finish('', 'DELETE');
              }}><SquareKanban size={12} />{t('service.openBoard')}</Button>
            )}
            <Button variant="primary" disabled={busy} onClick={() => void finish('', 'DELETE')}>{t('common.close')}</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Comes back after a reload too: the job is on the server, and so is the dialog's reason to be open. */
export function ModalServiceTasks({ boardLink }: { boardLink?: boolean }) {
  const task = (useApi<ServiceTask[]>('/api/service/tasks', ['service']).data ?? []).find((x) => x.modal);
  return task ? <TaskDialog key={task.id} task={task} boardLink={boardLink} /> : null;
}
