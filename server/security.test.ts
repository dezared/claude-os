import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { allowedHost, allowedOrigin, checkRequest, hasValidCookie } from './security.ts';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test('DNS rebinding: a foreign Host is rejected', () => {
  assert.equal(allowedHost('evil.example:47821', 47821), false);
  assert.equal(allowedHost('127.0.0.1:47821', 47821), true);
  assert.equal(allowedHost('127.0.0.1:1', 47821), false);
});

test('CSRF: a foreign Origin is rejected', () => {
  assert.equal(allowedOrigin('https://evil.example', 47821), false);
  assert.equal(allowedOrigin('http://localhost:47821', 47821), true);
  assert.equal(allowedOrigin(undefined, 47821), true);
});

test('cookie must match the token exactly', () => {
  assert.equal(hasValidCookie('claude_os=abc', 'abc'), true);
  assert.equal(hasValidCookie('claude_os=abd', 'abc'), false);
  assert.equal(hasValidCookie('claude_os=abcd', 'abc'), false);
  assert.equal(hasValidCookie(undefined, 'abc'), false);
});

test('checkRequest applies host, origin, then auth', () => {
  const ok = { host: '127.0.0.1:1', cookie: 'claude_os=t' };
  assert.equal(checkRequest(req(ok), 1, 't'), 'ok');
  assert.equal(checkRequest(req({ ...ok, host: 'x:1' }), 1, 't'), 'host');
  assert.equal(checkRequest(req({ ...ok, origin: 'http://x' }), 1, 't'), 'origin');
  assert.equal(checkRequest(req({ host: '127.0.0.1:1' }), 1, 't'), 'auth');
});
