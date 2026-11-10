import { Maximize, Minimize, Minus, PauseCircle, Power } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, ApiError, peekCached, useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { tabTitle } from '@/lib/tabTitle';
import { toastError, useApp } from '@/lib/store';
import type { Tab } from '@/lib/types';
import { activeTabs, desktop, popoutBridge, setDesktopPrefs, tabNotices, useDesktopPrefs, usePopouts, type DesktopApp, type DesktopBridge, type TabMark } from './desktop';
import { Checkbox, Dialog } from './ui';

// Whether the window is in full screen is the window's own fact, the page only follows it.
// The caption buttons of Windows are 3 × 46 px: the width until the overlay can be asked, which it cannot in full screen.
const useFullscreen = create<{ on: boolean; captionWidth: number }>(() => ({ on: false, captionWidth: 138 }));

type CaptionOverlay = EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect };

/** The room the caption buttons take on the title bar and whether they are gone. Null in a plain browser: no such buttons. */
export function useCaptionRoom() {
  const on = useFullscreen((s) => s.on);
  const width = useFullscreen((s) => s.captionWidth);
  return desktop() ? { on, width } : null;
}

async function stopEverything(bridge: DesktopBridge, done: () => void) {
  try {
    await api('/api/app/shutdown', { method: 'POST' });
    bridge.answerClose('quit');
  } catch (e) {
    // No server left to stop: nothing keeps the app from quitting.
    if (e instanceof ApiError && e.status === 0) bridge.answerClose('quit');
    else toastError(e);
  }
  done();
}

function CloseDialog({ bridge }: { bridge: DesktopBridge }) {
  const [running, setRunning] = useState<Tab[] | null>(null);
  const [remember, setRemember] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => bridge.onCloseRequest(({ fromTray }) => {
    const offline = useApp.getState().connection === 'offline';
    const active = offline ? [] : activeTabs(peekCached<Tab[]>('/api/tabs') ?? []);
    // Nothing running, but a window of its own is still open: the main window steps aside as with a session running.
    if (active.length === 0) return bridge.answerClose(!fromTray && usePopouts.getState().keys.length > 0 ? 'tray' : 'quit');
    const { closeChoice } = useDesktopPrefs.getState();
    if (closeChoice === 'stop') return void stopEverything(bridge, () => {});
    // Quit from the tray is the way out of the background: going back there would be no answer.
    if (closeChoice === 'tray' && !fromTray) return bridge.answerClose('tray');
    bridge.answerClose('dialog');
    setRemember(false);
    setRunning(active);
  }), [bridge]);

  const choose = (choice: 'tray' | 'stop') => {
    if (remember) setDesktopPrefs({ closeChoice: choice });
    if (choice === 'tray') {
      setRunning(null);
      bridge.answerClose('tray');
      return;
    }
    setStopping(true);
    void stopEverything(bridge, () => {
      setStopping(false);
      setRunning(null);
    });
  };

  const option = 'press flex w-full items-start gap-3 rounded-xl border border-line px-3 py-2.5 text-left hover:border-white/20 hover:bg-white/[.05] disabled:opacity-50';
  return (
    <Dialog open={running !== null} onOpenChange={(open) => !open && setRunning(null)} title={t('desktop.closeTitle')} description={t('desktop.closeText', { list: (running ?? []).map((tab) => tabTitle(tab, t('tabs.root'))).join(', ') })}>
      <div className="flex flex-col gap-2">
        <button type="button" disabled={stopping} onClick={() => choose('tray')} className={option}>
          <PauseCircle size={15} className="mt-0.5 flex-none text-accent" />
          <span><span className="block text-fg">{t('desktop.keep')}</span><span className="text-xs text-dim">{t('desktop.keepHint')}</span></span>
        </button>
        <button type="button" disabled={stopping} onClick={() => choose('stop')} className={option}>
          <Power size={15} className="mt-0.5 flex-none text-bad" />
          <span><span className="block text-fg">{t('desktop.stopAll')}</span><span className="text-xs text-dim">{t('desktop.stopAllHint')}</span></span>
        </button>
        <div className="mt-1">
          <Checkbox checked={remember} onChange={setRemember}>{t('desktop.remember')}</Checkbox>
        </div>
      </div>
    </Dialog>
  );
}

/** Follows the tabs the server already reports over the socket and tells the window what is worth a notification. */
function Notifier({ bridge }: { bridge: DesktopBridge }) {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data;
  const seen = useRef<Map<string, TabMark> | null>(null);
  useEffect(() => {
    if (!tabs) return;
    const before = seen.current;
    seen.current = new Map(tabs.map((tab) => [tab.id, { status: tab.status, attention: tab.attention }]));
    if (!before || !useDesktopPrefs.getState().notifications) return;
    if (!document.hidden && document.hasFocus()) return;
    for (const tab of tabNotices(before, tabs)) bridge.notify({ title: tabTitle(tab, t('tabs.root')), body: t('desktop.ask'), tabId: tab.id });
  }, [tabs, bridge]);
  useEffect(() => bridge.onOpenTab((tabId) => {
    const tab = peekCached<Tab[]>('/api/tabs')?.find((x) => x.id === tabId);
    if (!tab) return;
    useApp.getState().go(tab.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: tab.id });
  }), [bridge]);
  return null;
}

/** The window's half of the app: nothing of this exists in a plain browser. */
export function DesktopHost() {
  const bridge = desktop();
  const mode = useDesktopPrefs((s) => s.fullscreenMode);
  useEffect(() => {
    if (!bridge) return;
    bridge.setLabels({ open: t('desktop.trayOpen'), quit: t('desktop.trayQuit'), cut: t('desktop.cut'), copy: t('desktop.copy'), paste: t('desktop.paste') });
    void bridge.isFullscreen().then((on) => useFullscreen.setState({ on })).catch(() => {});
    return bridge.onFullscreen((on) => useFullscreen.setState({ on }));
  }, [bridge]);
  useEffect(() => {
    const windows = popoutBridge();
    if (!windows) return;
    void windows.popouts().then((keys) => usePopouts.setState({ keys })).catch(() => {});
    const offList = windows.onPopouts((keys) => usePopouts.setState({ keys }));
    const offView = windows.onShowView((view) => {
      const app = useApp.getState();
      if (view === 'planner') app.openPlanner();
      else app.go(view);
    });
    return () => {
      offList();
      offView();
    };
  }, []);
  useEffect(() => {
    const overlay = (navigator as unknown as { windowControlsOverlay?: CaptionOverlay }).windowControlsOverlay;
    if (!bridge || !overlay) return;
    const measure = () => {
      if (!overlay.visible) return;
      const area = overlay.getTitlebarAreaRect();
      useFullscreen.setState({ captionWidth: Math.max(0, innerWidth - area.x - area.width) });
    };
    measure();
    overlay.addEventListener('geometrychange', measure);
    return () => overlay.removeEventListener('geometrychange', measure);
  }, [bridge]);
  useEffect(() => {
    if (!bridge?.canFullscreen) return;
    if (!mode) {
      bridge.setFullscreen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      bridge.setFullscreen(!useFullscreen.getState().on);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge, mode]);
  if (!bridge) return null;
  return (
    <>
      <CloseDialog bridge={bridge} />
      <Notifier bridge={bridge} />
    </>
  );
}

export function FullscreenButton() {
  const bridge = desktop();
  const mode = useDesktopPrefs((s) => s.fullscreenMode);
  const on = useFullscreen((s) => s.on);
  if (!bridge?.canFullscreen || !mode) return null;
  const label = on ? t('desktop.exitFullscreen') : t('desktop.enterFullscreen');
  return (
    <button type="button" aria-label={label} title={`${label} · F11`} onClick={() => bridge.setFullscreen(!on)} className="press flex h-7 items-center rounded-md px-2 text-muted hover:bg-white/[.08] hover:text-fg">
      {on ? <Minimize size={14} /> : <Maximize size={14} />}
    </button>
  );
}

/** Stands in for the taskbar the full-screen window covers. With no list from Windows it is just the way back. */
export function DesktopBar() {
  const bridge = desktop();
  const mode = useDesktopPrefs((s) => s.fullscreenMode);
  const on = useFullscreen((s) => s.on);
  const visible = Boolean(bridge?.canFullscreen && mode && on);
  const [apps, setApps] = useState<DesktopApp[]>([]);
  useEffect(() => {
    if (!visible || !bridge) return;
    void bridge.currentApps().then(setApps).catch(() => {});
    return bridge.onApps(setApps);
  }, [visible, bridge]);
  if (!visible || !bridge) return null;
  const control = 'press flex size-8 flex-none items-center justify-center rounded-md text-muted hover:bg-white/[.08] hover:text-fg';
  return (
    <div role="toolbar" aria-label={t('desktop.bar')} className="pointer-events-auto relative z-20 flex h-10 flex-none items-center gap-1 border-t border-white/[.06] bg-[#050508]/70 px-2 backdrop-blur-md">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {apps.map((app) => (
          <button key={app.id} type="button" aria-label={app.title} title={app.title} onClick={() => bridge.activateApp(app.id)} className="press group flex size-8 flex-none items-center justify-center rounded-md hover:bg-white/[.08]">
            {app.icon ? (
              <img src={app.icon} alt="" draggable={false} className="size-5 opacity-60 transition-opacity group-hover:opacity-100" />
            ) : (
              <span className="text-xs font-medium text-muted opacity-60 group-hover:opacity-100">{app.title.trim().slice(0, 1).toUpperCase()}</span>
            )}
          </button>
        ))}
      </div>
      <button type="button" aria-label={t('desktop.minimize')} title={t('desktop.minimize')} onClick={() => bridge.minimize()} className={control}>
        <Minus size={14} />
      </button>
      <button type="button" aria-label={t('desktop.exitFullscreen')} title={`${t('desktop.exitFullscreen')} · F11`} onClick={() => bridge.setFullscreen(false)} className={control}>
        <Minimize size={14} />
      </button>
    </div>
  );
}
