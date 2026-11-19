// The agentation daemon under the Claude OS origin: a window that reaches Claude OS reaches its notes server too, with no
// port forwarding of its own (a Windows window does not see a WSL port other than the one it was opened from). The target is
// the daemon on the loopback alone: the path only ever replaces the URL's path, so no request leaves for another host.
import type { PluginRequest, PluginRoute } from '../../../server/tools/pluginServerApi.ts';

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const PASSED = ['accept', 'last-event-id']; // what the toolbar's requests and its event stream say; never the Claude OS cookie
// Set again by Claude OS for the body it sends; CORS is moot under one origin.
const dropped = (name: string) => ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(name) || name.startsWith('access-control-');

/** The daemon's URL for a proxied request: always the daemon's own origin. */
export function targetUrl(base: string, req: PluginRequest) {
  const url = new URL(base);
  url.pathname = `/${req.params['*']}`;
  for (const [key, value] of Object.entries(req.query)) url.searchParams.set(key, value);
  return url;
}

async function forward(base: string, method: string, req: PluginRequest) {
  const headers = new Headers();
  for (const name of PASSED) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const body = method === 'GET' || req.body == null ? undefined : JSON.stringify(req.body);
  if (body) headers.set('content-type', 'application/json');
  try {
    const res = await fetch(targetUrl(base, req), { method, headers, body, redirect: 'manual' });
    const out = new Headers();
    res.headers.forEach((value, name) => {
      if (!dropped(name)) out.set(name, value);
    });
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return Response.json({ error: 'the agentation server does not answer' }, { status: 502 });
  }
}

/** /api/plugins/agentation/proxy/<path> → <base>/<path>, every method the toolbar uses. */
export const proxyRoutes = (base: string): PluginRoute[] => METHODS.map((method) => ({ method, path: '/proxy/*', handler: (req: PluginRequest) => forward(base, method, req) }));
