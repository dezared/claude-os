// In a plain browser tab a toast is not seen from another app: the browser's own notification is, once allowed.
// Browsers grant it only on a click, so asking is a button in the settings, never a prompt on load.

export type BrowserNotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export function browserNotifyState(): BrowserNotifyState {
  if (typeof Notification === 'undefined' || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

export async function askBrowserNotify(): Promise<BrowserNotifyState> {
  if (browserNotifyState() === 'unsupported') return 'unsupported';
  return Notification.requestPermission();
}

/** Shown when allowed; a click brings the tab forward and runs `onClick`. False when it could not be shown. */
export function browserNotify(title: string, body: string, tag: string, onClick: () => void): boolean {
  if (browserNotifyState() !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
    return true;
  } catch {
    return false; // some browsers allow notifications only from a service worker
  }
}
