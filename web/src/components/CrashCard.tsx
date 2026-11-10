import { Component, type ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { describeError, reloadAndFix, restartServer } from '@/lib/crash';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { AppStatus } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';

function CrashCard({ error, where }: { error: Error; where: string }) {
  const status = useApi<AppStatus>('/api/app/status').data;
  const button = 'press rounded-md border border-line px-2.5 py-1 text-muted hover:text-fg';
  return (
    <div role="alert" className="max-w-xl p-8">
      <h1 className="mb-2 text-base font-medium">{t('app.crashTitle')}</h1>
      <pre className="selectable mb-3 overflow-auto font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted">{error.message}</pre>
      {status?.stale && <p className="mb-3 text-xs text-soft">{t('crash.staleHint')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {status?.stale && <button type="button" onClick={() => restartServer().catch(toastError)} className={button}>{t('crash.restart')}</button>}
        <button type="button" onClick={() => location.reload()} className={button}>{t('app.crashReload')}</button>
        <button type="button" onClick={() => reloadAndFix({ where, error: describeError(error) })} className={`${button} flex items-center gap-1.5`}>
          <ClaudeMark size={12} />
          {t('crash.reloadAndFix')}
        </button>
      </div>
    </div>
  );
}

/** One broken part must leave the rest of the app working. `hidden`: a screen kept mounted out of sight stays quiet about it. */
export class ScreenBoundary extends Component<{ children: ReactNode; resetKey: string; where: string; hidden?: boolean }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    if (!this.state.error) return this.props.children;
    return this.props.hidden ? null : <CrashCard error={this.state.error} where={this.props.where} />;
  }
}
