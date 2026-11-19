import { useState, type ReactNode } from 'react';
import { desktop, setDesktopPrefs, useDesktopPrefs, type CloseChoice } from '@/components/desktop';
import { Button, Checkbox, Select } from '@/components/ui';
import { askBrowserNotify, browserNotifyState } from '@/lib/browserNotify';
import { t } from '@/lib/i18n';

// The building blocks of the settings screen, apart so the screen itself stays under its size cap.

export function Head({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-dim">{hint}</p>}
      </div>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
    </header>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-line2 py-2.5 first:border-t-0">
      <div className="min-w-52 flex-1">
        <div className="text-soft">{label}</div>
        {hint && <div className="mt-px text-[11.5px] leading-[1.45] text-dim">{hint}</div>}
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className="mb-6 rounded-xl bg-fg/[.025] light:bg-card px-4 py-1 shadow-[inset_0_0_0_1px_var(--color-line2)]">{children}</div>;
}

export const onOff = (on: boolean) => t(on ? 'desktop.enabled' : 'desktop.disabled');

// In a browser only notifications can be set, through the browser's own permission.
function BrowserRows() {
  const prefs = useDesktopPrefs();
  const [state, setState] = useState(browserNotifyState);
  if (state === 'unsupported') return null;
  return (
    <Row label={t('desktop.notifySetting')} hint={t(state === 'denied' ? 'desktop.browserNotifyDenied' : 'desktop.browserNotifyHint')}>
      {state === 'granted' && <Checkbox checked={prefs.notifications} onChange={(v) => setDesktopPrefs({ notifications: v })}>{onOff(prefs.notifications)}</Checkbox>}
      {state === 'default' && <Button onClick={() => void askBrowserNotify().then(setState)}>{t('desktop.browserNotifyAllow')}</Button>}
    </Row>
  );
}

// Only the window has a tray and fullscreen.
export function DesktopRows() {
  const prefs = useDesktopPrefs();
  const bridge = desktop();
  if (!bridge) return <BrowserRows />;
  return (
    <>
      <Row label={t('desktop.closeSetting')} hint={t('desktop.closeSettingHint')}>
        <Select
          className="w-56"
          ariaLabel={t('desktop.closeSetting')}
          value={prefs.closeChoice}
          onChange={(v) => setDesktopPrefs({ closeChoice: (v ?? 'ask') as CloseChoice })}
          options={[{ value: 'ask', label: t('desktop.closeAsk') }, { value: 'tray', label: t('desktop.keep') }, { value: 'stop', label: t('desktop.stopAll') }]}
        />
      </Row>
      <Row label={t('desktop.notifySetting')} hint={t('desktop.notifyHint')}>
        <Checkbox checked={prefs.notifications} onChange={(v) => setDesktopPrefs({ notifications: v })}>{onOff(prefs.notifications)}</Checkbox>
      </Row>
      {bridge.canFullscreen && (
        <Row label={t('desktop.fullscreenSetting')} hint={t('desktop.fullscreenHint')}>
          <Checkbox checked={prefs.fullscreenMode} onChange={(v) => setDesktopPrefs({ fullscreenMode: v })}>{onOff(prefs.fullscreenMode)}</Checkbox>
        </Row>
      )}
    </>
  );
}
