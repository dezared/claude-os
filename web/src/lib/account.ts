import { useEffect } from 'react';
import { peekCached, useApi } from './api';
import { t } from './i18n';
import type { AccountStatus } from './types';

const VISIBLE_REFRESH_MS = 5 * 60_000;

export function useAccount() {
  return useApi<AccountStatus>('/api/account', ['account']);
}

/** Dollars mean something only for real API use. On a subscription they are never shown. */
export function useShowCost(): boolean {
  return useAccount().data?.billing === 'api';
}

/** What a Claude-run action costs this user, for any button that starts one. */
export function spendNote(): string {
  const a = peekCached<AccountStatus>('/api/account');
  if (a?.billing === 'api') return t('cost.api');
  if (a?.billing === 'subscription') return a.plan ? t('cost.plan', { plan: a.plan }) : t('cost.subscription');
  return t('cost.unknown');
}

/** Usage from other devices and terminal sessions has no event here: a slow refresh while the window is in view. */
export function useAccountRefresh(refetch: () => void) {
  useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refetch();
    }, VISIBLE_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [refetch]);
}
