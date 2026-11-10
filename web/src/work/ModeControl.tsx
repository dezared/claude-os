import { Check, ChevronDown, FilePen, ListChecks, Shield, ShieldCheck, ShieldOff, ShieldQuestion, Sparkles, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import { api, setCached } from '@/lib/api';
import type { ChatState } from '@/lib/chat';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { Tab } from '@/lib/types';
import { useTabCommand } from './tabCommands';

export const BYPASS = 'bypassPermissions';

// Every mode of the SDK's PermissionMode.
const MODES: { id: string; label: Parameters<typeof t>[0]; about: Parameters<typeof t>[0]; icon: LucideIcon }[] = [
  { id: 'default', label: 'mode.default', about: 'mode.defaultAbout', icon: ShieldQuestion },
  { id: 'acceptEdits', label: 'mode.acceptEdits', about: 'mode.acceptEditsAbout', icon: FilePen },
  { id: 'plan', label: 'mode.plan', about: 'mode.planAbout', icon: ListChecks },
  { id: 'auto', label: 'mode.auto', about: 'mode.autoAbout', icon: Sparkles },
  { id: 'dontAsk', label: 'mode.dontAsk', about: 'mode.dontAskAbout', icon: ShieldCheck },
  { id: BYPASS, label: 'mode.bypass', about: 'mode.bypassAbout', icon: ShieldOff },
];

export async function setTabMode(tabId: string, mode: string): Promise<void> {
  try {
    const updated = await api<Tab>(`/api/tabs/${encodeURIComponent(tabId)}`, { method: 'PATCH', body: { permissionMode: mode } });
    setCached<Tab[]>('/api/tabs', (old) => (old ?? []).map((x) => (x.id === updated.id ? updated : x)));
  } catch (e) {
    toastError(e);
  }
}

/** The permission mode as quiet underlined text; the choice with what each mode does is a real dialog. */
export function ModeControl({ tab, chat }: { tab: Tab; chat: ChatState }) {
  const [open, setOpen] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState(false);
  useTabCommand(tab.id, 'mode', () => setOpen(true));
  const mode = chat.permissionMode ?? tab.permissionMode ?? null;
  const known = MODES.find((m) => m.id === mode);
  const Icon = known?.icon ?? Shield;
  const label = known ? t(known.label) : mode ?? t('mode.fromSettings');

  const change = (next: string) => {
    setOpen(false);
    setConfirmBypass(false);
    if (next !== mode) void setTabMode(tab.id, next);
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${t('mode.aria')}: ${label}`}
        title={t('mode.aria')}
        onClick={() => setOpen(true)}
        className="press inline-flex max-w-44 flex-none items-center gap-1 rounded text-[11px] text-muted underline decoration-white/25 underline-offset-3 hover:text-fg hover:decoration-white/60"
      >
        <Icon size={11} className="flex-none" />
        <span className="truncate">{label}</span>
        <ChevronDown size={11} className="flex-none" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmBypass(false);
        }}
        title={t('mode.dialogTitle')}
        description={t('mode.dialogHint')}
      >
        <div role="radiogroup" aria-label={t('mode.dialogTitle')} className="flex flex-col gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === mode}
              onClick={() => (m.id === BYPASS && mode !== BYPASS ? setConfirmBypass(true) : change(m.id))}
              className={cn('press flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised', m.id === mode && 'bg-raised')}
            >
              <m.icon size={14} className={cn('mt-0.5 flex-none', m.id === mode ? 'text-accent' : 'text-dim')} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg">{t(m.label)}</span>
                <span className="block text-xs text-muted">{t(m.about)}</span>
              </span>
              {m.id === mode && <Check size={14} className="mt-0.5 flex-none text-accent" />}
            </button>
          ))}
        </div>
        {confirmBypass && (
          <div role="alert" className="enter-fade mt-3 flex items-center gap-2 rounded-md border border-accent-deep bg-accent-bg px-3 py-2 text-xs text-soft">
            <ShieldOff size={13} className="flex-none text-accent" />
            <span className="min-w-0 flex-1">{t('mode.bypassConfirm')}</span>
            <Button size="sm" variant="primary" className="flex-none" onClick={() => change(BYPASS)}>{t('mode.bypassOn')}</Button>
            <Button size="sm" className="flex-none" onClick={() => setConfirmBypass(false)}>{t('common.cancel')}</Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
