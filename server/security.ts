import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'claude_os';

export function loadToken(dataDir: string): string {
  const file = join(dataDir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// A missing Origin is a non-browser client or a same-origin GET; those still need the cookie.
export function allowedOrigin(origin: string | undefined, port: number, devOrigin?: string): boolean {
  if (!origin) return true;
  if (devOrigin && origin === devOrigin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hasValidCookie(header: string | undefined, token: string): boolean {
  if (!header) return false;
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE && value && safeEqual(value, token)) return true;
  }
  return false;
}

export function authCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

export function checkRequest(req: IncomingMessage, port: number, token: string, devOrigin?: string): 'ok' | 'host' | 'origin' | 'auth' {
  if (!allowedHost(req.headers.host, port)) return 'host';
  if (!allowedOrigin(req.headers.origin, port, devOrigin)) return 'origin';
  if (!hasValidCookie(req.headers.cookie, token)) return 'auth';
  return 'ok';
}
