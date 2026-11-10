import * as Popover from '@radix-ui/react-popover';
import { Gauge, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, setCached } from '@/lib/api';
import { useAccount, useAccountRefresh } from '@/lib/account';
import { cn, fmtAgo, fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { AccountStatus, LimitWindow } from '@/lib/types';
import { IconButton } from './ui';

function windowLabel(w: LimitWindow): string {
  const base = w.kind === 'session' ? t('limits.session') : w.kind === 'weekly_all' ? t('limits.weekly') : w.kind === 'weekly_scoped' ? t('limits.weeklyScoped') : w.kind;
  return w.label ? `${base} · ${w.label}` : base;
}

function Meter({ w }: { w: LimitWindow }) {
  const percent = w.percent ?? 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-soft">{windowLabel(w)}</span>
        <span className="flex-none text-muted">{w.percent === null ? t('common.noData') : `${Math.round(percent)}%`}</span>
      </div>
      <div className="h-1 rounded-full bg-white/10">
        <i className={cn('block h-full rounded-full', w.severity && w.severity !== 'normal' ? 'bg-accent' : 'bg-white/55')} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      {w.resetsAt && <div className="mt-1 text-[11px] text-dim">{t('limits.resets', { at: fmtDateTime(w.resetsAt) })}</div>}
    </div>
  );
}

const sourceKey = { usage: 'limits.sourceUsage', cache: 'limits.sourceCache', events: 'limits.sourceEvents', none: 'limits.sourceNone' } as const;

/** Compact plan and limit in the title bar; the detail opens on click. */
export function LimitsBadge() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  useAccountRefresh(account.refetch);
  const a = account.data;
  const headline = a?.windows.find((w) => w.active) ?? a?.windows[0];
  if (!a) return null;
  const used = headline?.percent ?? 0;
  const usageTone = used > 95 ? 'text-[#e5867a]' : used > 70 ? 'text-[#e6c07b]' : 'text-soft';

  const refresh = async () => {
    setBusy(true);
    try {
      const next = await api<AccountStatus>('/api/account?refresh=1');
      setCached<AccountStatus>('/api/account', () => next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('limits.aria')}
          title={t('limits.aria')}
          className="press mr-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] whitespace-nowrap text-muted hover:bg-white/[.08] hover:text-fg"
        >
          <Gauge size={13} className="text-dim" />
          {a.plan && <span className="hidden xl:inline">{a.plan}</span>}
          {headline?.percent != null && <b className={cn('font-medium', usageTone)}>{Math.round(headline.percent)}%</b>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="enter-pop popover z-50 w-80 rounded-xl p-3 outline-none">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] text-dim">{t('limits.plan')}</div>
              <div className="truncate text-sm font-medium">{a.plan ?? t('common.noData')}</div>
            </div>
            <IconButton label={t('limits.refresh')} disabled={busy} onClick={refresh}><RefreshCw size={13} className={busy ? 'spinner' : ''} /></IconButton>
          </div>
          {a.windows.length > 0 ? (
            <div className="flex flex-col gap-2.5">{a.windows.map((w, i) => <Meter key={`${w.kind}${w.label}${i}`} w={w} />)}</div>
          ) : (
            <p className="text-xs text-muted">{t('limits.noWindows')}</p>
          )}
          {a.events.length > 0 && (
            <div className="mt-3 border-t border-line2 pt-2">
              <div className="mb-1 text-[11px] text-dim">{t('limits.events')}</div>
              {a.events.map((e) => (
                <div key={e.type} className="flex justify-between gap-2 text-[11px] text-muted">
                  <span className="min-w-0 truncate">{e.type || '–'}{e.status ? ` · ${e.status}` : ''}{e.utilization != null ? ` · ${Math.round(e.utilization)}%` : ''}</span>
                  <span className="flex-none text-dim">{fmtAgo(e.receivedAt)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 border-t border-line2 pt-2 text-[11px] leading-[1.45] text-dim">
            {t(sourceKey[a.source])}
            {a.receivedAt ? ` ${t('limits.received', { ago: fmtAgo(a.receivedAt) })}` : ''}
            {a.error ? ` ${t('limits.failed', { error: a.error })}` : ''}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
