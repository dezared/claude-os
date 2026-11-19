// The proxy against a stand-in daemon: every method with its body and status, the event stream as it comes, and no way to
// aim it at another host.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { PluginRequest } from '../../../server/tools/pluginServerApi.ts';
import { proxyRoutes, targetUrl } from './proxy.ts';

let upstream: Server;
let base: string;
const seen: { method: string; url: string; body: string; headers: Record<string, unknown> }[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      if (req.url === '/sessions/s1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
        res.write(': connected\n\n');
        setTimeout(() => res.write('data: {"type":"annotation.created"}\n\n'), 50);
        return;
      }
      if (req.url === '/missing') return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
      if (req.method === 'DELETE') return void res.writeHead(204).end();
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
after(() => {
  upstream.closeAllConnections();
  upstream.close();
});

const request = (rest: string, more: Partial<PluginRequest> = {}): PluginRequest => ({ params: { '*': rest }, query: {}, headers: {}, body: null, ...more });
async function send(method: string, req: PluginRequest) {
  const route = proxyRoutes(base).find((r) => r.method === method);
  assert.ok(route, method);
  return (await route.handler(req)) as Response;
}

describe('agentation proxy', () => {
  it('passes each method with its body, query and status, and keeps the cookie and CORS to itself', async () => {
    const posted = await send('POST', request('sessions', { body: { url: 'http://127.0.0.1:47821/' }, headers: { cookie: 'claude_os=secret', accept: 'application/json' } }));
    assert.equal(posted.status, 201);
    assert.deepEqual(await posted.json(), { method: 'POST', url: '/sessions', body: { url: 'http://127.0.0.1:47821/' } });
    assert.equal(seen.at(-1)?.headers.cookie, undefined, 'the Claude OS cookie stays home');
    assert.equal(seen.at(-1)?.headers.accept, 'application/json');

    const patched = await send('PATCH', request('annotations/a1', { body: { status: 'acknowledged' } }));
    assert.deepEqual(await patched.json(), { method: 'PATCH', url: '/annotations/a1', body: { status: 'acknowledged' } });
    const got = await send('GET', request('sessions', { query: { limit: '5' } }));
    assert.equal(((await got.json()) as { url: string }).url, '/sessions?limit=5');
    assert.equal((await send('DELETE', request('annotations/a1'))).status, 204);
    const missing = await send('GET', request('missing'));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not found' });
  });

  it('streams the event stream as it comes, without waiting for its end', async () => {
    const res = await send('GET', request('sessions/s1/events', { headers: { 'last-event-id': '7' } }));
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(seen.at(-1)?.headers['last-event-id'], '7', 'a reconnect resumes where it stopped');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('annotation.created')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^: connected\n\n/);
    await reader.cancel();
  });

  it('never reaches another host, whatever the path says', () => {
    for (const rest of ['http://evil.example/x', '//evil.example/x', '@evil.example/x', '../../evil', 'a/../../b']) {
      assert.equal(targetUrl(base, request(rest)).origin, base, rest);
    }
  });

  it('a daemon that does not answer is a 502, not a server error', async () => {
    const routes = proxyRoutes('http://127.0.0.1:9');
    const res = (await routes[0].handler(request('health'))) as Response;
    assert.equal(res.status, 502);
  });
});
