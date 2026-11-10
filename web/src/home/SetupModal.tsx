import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Spinner } from '@/components/states';
import { Button, Dialog } from '@/components/ui';
import { api, ApiError, setCached, useApi } from '@/lib/api';
import { useChat } from '@/lib/chat';
import { cn, fmtDateTime } from '@/lib/format';
import { locale, t, type Key } from '@/lib/i18n';
import { toastError, useApp } from '@/lib/store';
import type { Profile, SettingsView, SetupCheck, SetupState, Tab } from '@/lib/types';
import { attachTab } from '@/lib/ws';

type SetupView = { setup: SetupState; profile: Profile | null };

// "Later" lasts until the app starts again: a new browser session asks again.
const LATER_KEY = 'claude-os.setup.later';
const useSetupLater = create<{ later: boolean }>(() => ({ later: sessionStorage.getItem(LATER_KEY) === '1' }));

/** The menu's "Run setup again": a finished setup goes back to its checks, and the modal opens over Home. */
export async function runSetupAgain() {
  try {
    const { setup } = await api<SetupView>('/api/setup');
    if (setup.completedAt !== null) {
      const next = await api<SetupState>('/api/setup/restart', { method: 'POST' });
      setCached<SetupView>('/api/setup', (old) => ({ profile: old?.profile ?? null, setup: next }));
    }
    sessionStorage.removeItem(LATER_KEY);
    useSetupLater.setState({ later: false });
    useApp.getState().go({ kind: 'home' });
  } catch (err) {
    toastError(err);
  }
}

const ICONS = { ok: CircleCheck, warn: TriangleAlert, fail: CircleX } as const;
const TONES = { ok: 'text-ok', warn: 'text-warn', fail: 'text-bad' } as const;

function resetsAt(ms: number): string {
  const sameDay = new Date(ms).toDateString() === new Date().toDateString();
  return sameDay ? new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : fmtDateTime(ms);
}

// What was found, on the right of the row. 'unknown' and 'unreadable' are words for the fix line, not values.
function detailText(c: SetupCheck): string | null {
  if (c.limit) {
    const parts = [c.limit.percent !== null && t('setup.limit.percent', { percent: Math.round(c.limit.percent) }), c.limit.resetsAt !== null && t('setup.limit.resets', { time: resetsAt(c.limit.resetsAt) })];
    return parts.filter(Boolean).join(', ') || null;
  }
  return c.detail === 'unknown' || c.detail === 'unreadable' ? null : c.detail;
}

// The installer command is the one for the system the server runs on: WSL is Linux.
function fixText(c: SetupCheck, windows: boolean): string | null {
  if (c.status === 'ok') return null;
  if (c.detail === 'unknown') return t('setup.fix.unknown');
  if (c.id === 'claude-binary' && windows) return t('setup.fix.claude-binary.windows');
  if (c.id === 'claude-version' && c.detail === 'unreadable') return t('setup.fix.claude-version.unreadable');
  return t(`setup.fix.${c.id}` as Key);
}

function CheckRow({ c, windows }: { c: SetupCheck; windows: boolean }) {
  const Icon = ICONS[c.status];
  const detail = detailText(c);
  const fix = fixText(c, windows);
  return (
    <li data-status={c.status} className="enter-fade flex items-start gap-2.5 py-1.5">
      <Icon size={14} aria-hidden className={cn('mt-0.5 flex-none', TONES[c.status])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-soft">{t(`setup.item.${c.id}` as Key)}</span>
          {detail && <span className="selectable truncate font-mono text-[11.5px] text-dim" title={detail}>{detail}</span>}
        </div>
        {fix && <div className="mt-0.5 text-xs text-muted">{fix}</div>}
      </div>
    </li>
  );
}

function SetupBody({ setup }: { setup: SetupState }) {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const windows = useApi<SettingsView>('/api/settings', ['settings']).data?.platform === 'windows';
  const tab = setup.tabId ? tabs.data?.find((x) => x.id === setup.tabId) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab) void attachTab(tab.id);
  }, [tab?.id]);
  // A run that ended with an error, the limit or a crash: its reason, while the tab is idle. Working or asking is no failure.
  const lastResult = useChat((s) => (tab ? s.tabs[tab.id]?.items.findLast((i) => i.k === 'result') : undefined));
  const failure = tab?.status === 'idle' && lastResult?.k === 'result' && !lastResult.interrupted ? lastResult.error : null;

  const recheck = async (): Promise<SetupCheck[] | null> => {
    setChecking(true);
    setError(null);
    try {
      const list = await api<SetupCheck[]>('/api/setup/checks');
      setChecks(list);
      return list;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setChecking(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void recheck(), []);

  const proceed = async () => {
    setBusy(true);
    setError(null);
    try {
      const { go } = useApp.getState();
      if (failure) {
        const list = await recheck();
        if (!list || list.some((c) => c.status === 'fail')) return;
        // Claude has the conversation already: it goes on from there. Without a session, start sends the first prompt again.
        if (tab?.sessionId) {
          await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: t('setup.modal.continuePrompt') } });
          go({ kind: 'tab', id: tab.id });
          return;
        }
      }
      const opened = await api<Tab>('/api/setup/start', { method: 'POST' });
      setCached<Tab[]>('/api/tabs', (old) => [...(old ?? []).filter((x) => x.id !== opened.id), opened]);
      go({ kind: 'tab', id: opened.id });
    } catch (err) {
      // A refused start re-runs the checks first: they clear the old error, then this one shows.
      if (err instanceof ApiError && err.status === 409) await recheck();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blocked = !checks || checks.some((c) => c.status === 'fail');
  const action = failure ? t('setup.modal.retry') : setup.step === 'onboarding' ? t('setup.modal.continue') : t('setup.modal.start');
  return (
    <div className="flex flex-col gap-3">
      {checks ? (
        <ul className="flex flex-col">
          {checks.map((c) => (
            <CheckRow key={c.id} c={c} windows={windows} />
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2 py-2 text-xs text-muted">
          <Spinner size={13} /> {t('setup.modal.checking')}
        </div>
      )}
      {failure && <p role="alert" className="enter-fade text-xs text-bad">{t('setup.modal.failed', { reason: failure })}</p>}
      {error && <p role="alert" className="enter-fade text-xs text-bad">{error}</p>}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={() => void recheck()} disabled={checking}>
          {checking && checks && <Spinner size={12} />}
          {t('setup.modal.recheck')}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={postpone}>
            {t('setup.modal.later')}
          </Button>
          <Button variant="primary" disabled={blocked || busy || checking} onClick={() => void proceed()}>
            {action}
          </Button>
        </div>
      </div>
    </div>
  );
}

function postpone() {
  sessionStorage.setItem(LATER_KEY, '1');
  useSetupLater.setState({ later: true });
}

/** The first-run setup over Home while setup.completedAt is missing: checks of the machine, then a tab where Claude asks the rest. */
export function SetupModal({ visible }: { visible: boolean }) {
  const view = useApi<SetupView>('/api/setup', ['settings']);
  const later = useSetupLater((s) => s.later);
  const setup = view.data?.setup;
  const open = visible && !later && !!setup && setup.completedAt === null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && postpone()} title={t('setup.modal.title')} description={t('setup.modal.hint')} width={520}>
      {open && <SetupBody setup={setup} />}
    </Dialog>
  );
}
