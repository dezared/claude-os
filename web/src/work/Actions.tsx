import * as Popover from '@radix-ui/react-popover';
import { Play, ShieldAlert, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { toast, toastError } from '@/lib/store';
import type { ActionDef, Tab } from '@/lib/types';
import { t } from '@/lib/i18n';

export function useActions() {
  return useApi<ActionDef[]>('/api/actions', ['actions']);
}

/** `claude --resume`: for read-only sessions and commands that need the real terminal. */
export function findTerminalAction(actions: ActionDef[] | undefined): ActionDef | undefined {
  return actions?.find((a) => a.id === 'builtin:terminal');
}

function actionIcon(id: string): LucideIcon {
  return /terminal|shell/i.test(id) ? SquareTerminal : Play;
}

export function ActionButton({ action, tab, label, variant = 'outline' }: { action: ActionDef; tab: Pick<Tab, 'project' | 'cwd' | 'sessionId'>; label?: string; variant?: 'outline' | 'primary' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The server reports the exact text on a 409: the command can change after the list was loaded.
  const [pending, setPending] = useState<string | null>(null);
  const approved = action.approved && pending === null;
  const command = pending ?? action.command;

  const run = async () => {
    setBusy(true);
    try {
      const res = await api<{ ok: true; output: string; fork?: boolean }>(`/api/actions/${encodeURIComponent(action.id)}/run`, {
        method: 'POST',
        body: { project: tab.project ?? undefined, cwd: tab.cwd, sessionId: tab.sessionId ?? undefined },
      });
      if (res.output?.trim()) toast(res.output.trim().slice(0, 400));
      // The server decides at run time: this says what really opened, whatever the screen expected.
      if (res.fork !== undefined) toast(t(res.fork ? 'action.terminalCopy' : 'action.terminalSame'));
      setPending(null);
      setOpen(false);
    } catch (e) {
      const body = e instanceof ApiError && e.status === 409 ? (e.body as { command?: string } | null) : null;
      if (body?.command) {
        setPending(body.command);
        setOpen(true);
      } else {
        toastError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const approveAndRun = async () => {
    setBusy(true);
    try {
      // Approves the text shown here; the server answers 409 if the command changed meanwhile.
      await api(`/api/actions/${encodeURIComponent(action.id)}/approve`, { method: 'POST', body: { command } });
      setPending(null);
      await run();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const Icon = actionIcon(action.id);

  // The server does not enforce `confirm`: this popover is the confirmation.
  const direct = approved && !action.confirm;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant={variant}
          className="flex-none"
          disabled={busy}
          onClick={(e) => {
            if (direct) {
              e.preventDefault();
              void run();
            }
          }}
        >
          {approved ? <Icon size={12} /> : <ShieldAlert size={12} className="text-accent" />}
          {label ?? action.title}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="enter-pop popover z-50 w-96 rounded-xl p-3 outline-none">
          <p className="mb-2 text-xs text-muted">
            {approved ? t('action.willRun') : t('action.notApproved')}
          </p>
          <pre className="selectable mb-2 max-h-40 overflow-auto rounded-md border border-line2 bg-bg p-2 font-mono text-[11.5px] whitespace-pre-wrap wrap-anywhere text-soft">{command}</pre>
          {action.cwd && <p className="mb-2 font-mono text-[11px] wrap-anywhere text-dim">{t('action.cwd', { cwd: action.cwd })}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            {approved ? (
              <Button variant="primary" disabled={busy} onClick={run}>
                {t('action.run')}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={approveAndRun}>
                {t('action.approveRun')}
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The bar of a work tab: a plain shell at the folder, then the user's own actions. IDEs have their own button. */
export function ActionBar({ tab }: { tab: Tab }) {
  const actions = useActions();
  if (actions.error && !actions.data) return <span className="text-xs text-dim" title={actions.error}>{t('action.unavailable')}</span>;
  const shown = (actions.data ?? []).filter((a) => a.id !== 'builtin:terminal').sort((a, b) => Number(b.id === 'builtin:shell') - Number(a.id === 'builtin:shell'));
  return (
    <>
      {shown.map((a) => (
        <ActionButton key={a.id} action={a} tab={tab} label={a.id === 'builtin:shell' ? t('action.terminal') : undefined} />
      ))}
    </>
  );
}
