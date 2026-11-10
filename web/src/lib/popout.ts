// A separate window of the desktop app: the same page and session cookie, this route, nothing but one chat, the planner or the service tasks.
export type PopoutRequest = { kind: 'tab'; id: string } | { kind: 'root' } | { kind: 'planner' } | { kind: 'service' };

export function popoutRoute(): PopoutRequest | null {
  const query = new URLSearchParams(location.search);
  const kind = query.get('popout');
  if (kind === 'root' || kind === 'planner' || kind === 'service') return { kind };
  const id = query.get('id');
  return kind === 'tab' && id ? { kind, id } : null;
}

export const inPopout = popoutRoute() !== null;
