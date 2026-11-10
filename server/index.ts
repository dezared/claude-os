import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppStatus, ServerMessage, Topic } from '../shared/contract.ts';
import { newestCode } from './codeStamp.ts';
import { resolvePaths, type BusEvents, type Ctx } from './context.ts';
import { bootstrapConfig } from './defaults.ts';
import { allowedHost, authCookie, checkRequest, loadToken, safeEqual } from './security.ts';
import { registerJournal } from './journal/index.ts';
import { endClaudeChildren } from './journal/live.ts';
import { registerChat } from './chat/index.ts';
import { registerMemory } from './memory/index.ts';
import { registerTools } from './tools/index.ts';
import { registerVoice } from './voice/index.ts';

const PORT = Number(process.env.CLAUDE_OS_PORT ?? 47821);
const IDLE_EXIT_MS = Number(process.env.CLAUDE_OS_IDLE_EXIT_MS ?? 10 * 60_000); // 0 disables
const DEV_ORIGIN = process.env.CLAUDE_OS_DEV_ORIGIN;

const paths = resolvePaths();
try {
  console.info('config bootstrap', JSON.stringify(bootstrapConfig(join(paths.repo, 'defaults'), paths.config)));
} catch (err) {
  console.error('config bootstrap failed', err); // the readers cope with missing files: start anyway
}
const codeDirs = [join(paths.repo, 'server'), join(paths.repo, 'shared')];
const startedCode = newestCode(codeDirs);
const token = loadToken(paths.data);
const db = new DatabaseSync(join(paths.data, 'claude-os.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT
)`);

const app = Fastify({ bodyLimit: 50 * 1024 * 1024 });
const bus = new EventEmitter<BusEvents>();
const sockets = new Map<number, WebSocket>();
const messageHandlers: Parameters<Ctx['onClientMessage']>[0][] = [];
const closeHandlers: Parameters<Ctx['onClientClose']>[0][] = [];
const busy = new Set<string>();
let nextConn = 1;
let pendingTopics = new Set<Topic>();
let topicTimer: NodeJS.Timeout | null = null;

function broadcast(msg: ServerMessage) {
  const text = JSON.stringify(msg);
  for (const ws of sockets.values()) if (ws.readyState === ws.OPEN) ws.send(text);
}

const ctx: Ctx = {
  journal: null as unknown as Ctx['journal'], // assigned by registerJournal
  memory: null as unknown as Ctx['memory'], // assigned by registerMemory
  app, db, paths, bus, broadcast,
  invalidate(...topics) {
    topics.forEach((t) => pendingTopics.add(t));
    topicTimer ??= setTimeout(() => {
      topicTimer = null;
      broadcast({ t: 'invalidate', topics: [...pendingTopics] });
      pendingTopics = new Set();
    }, 150);
  },
  audit(action, target, diff = null) {
    db.prepare('INSERT INTO audit_log (at, action, target, diff) VALUES (?, ?, ?, ?)').run(Date.now(), action, target, diff);
    ctx.invalidate('audit');
  },
  onClientMessage: (h) => void messageHandlers.push(h),
  onClientClose: (h) => void closeHandlers.push(h),
  setBusy(key, on) { if (on) busy.add(key); else busy.delete(key); },
};

// Every request passes here: Host and Origin always, the cookie for everything but /auth and /health.
app.addHook('onRequest', async (req, reply) => {
  if (!allowedHost(req.headers.host, PORT)) return reply.code(403).send({ error: 'host' });
  const path = req.url.split('?')[0];
  if (path === '/auth' || path === '/health') return;
  const verdict = checkRequest(req.raw, PORT, token, DEV_ORIGIN);
  if (verdict === 'ok') return;
  return reply.code(verdict === 'auth' ? 401 : 403).send({ error: verdict });
});

const appStatus = (): AppStatus => ({ stale: newestCode(codeDirs) > startedCode, busy: busy.size > 0, repo: paths.repo });

app.get('/health', async () => ({ ok: true, pid: process.pid, ...appStatus() }));
app.get('/api/app/status', async () => appStatus());
app.get<{ Querystring: { token?: string } }>('/auth', async (req, reply) => {
  if (!req.query.token || !safeEqual(req.query.token, token)) return reply.code(401).send({ error: 'auth' });
  return reply.header('set-cookie', authCookie(token)).redirect('/');
});

// Only the window's "stop everything and quit" comes here. Closing the window alone never stops the server.
app.post('/api/app/shutdown', async () => {
  const stopped = ctx.chat?.stopAll() ?? 0;
  ctx.audit('app.shutdown', 'server', `${stopped} sessions stopped`);
  setTimeout(shutdown, 150);
  return { ok: true, stopped };
});

// Starts the code now on disk. A running turn stops, so the page says so before calling this, and goes on after the boot.
app.post('/api/app/restart', async () => {
  ctx.chat?.planContinue();
  const stopped = ctx.chat?.stopAll() ?? 0;
  ctx.audit('app.restart', 'server', `${stopped} sessions stopped`);
  setTimeout(() => void restart(), 150);
  return { ok: true, stopped };
});
// The root session's tool. The tool's answer must leave first, so stopping the sessions waits too.
ctx.restart = () => setTimeout(() => {
  ctx.chat?.stopAll();
  void restart();
}, 400);

app.setErrorHandler((err: Error & { statusCode?: number; code?: string; key?: string; params?: Record<string, string | number> }, _req, reply) => {
  if ((err.statusCode ?? 500) >= 500) app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code, key: err.key, params: err.params });
});

registerJournal(ctx);
registerMemory(ctx);
registerTools(ctx);
registerVoice(ctx);
registerChat(ctx);

const webDist = process.env.CLAUDE_OS_WEB_DIST ?? join(paths.repo, 'dist/web');
if (existsSync(webDist)) {
  // wildcard stays on: a file list taken at startup goes stale on the next web build and the page turns black.
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

const wss = new WebSocketServer({ noServer: true });
app.server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/ws' || checkRequest(req, PORT, token, DEV_ORIGIN) !== 'ok') {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const id = nextConn++;
    sockets.set(id, ws);
    const send = (m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    ws.on('message', (data) => {
      let raw: unknown;
      try { raw = JSON.parse(String(data)); } catch { return; }
      for (const h of messageHandlers) h(send, raw, id);
    });
    ws.on('close', () => {
      sockets.delete(id);
      for (const h of closeHandlers) h(id);
    });
  });
});

await app.listen({ port: PORT, host: '127.0.0.1' });

// serve.sh reads this to find a running server and its token.
const runtimeFile = join(paths.data, 'server.json');
writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, port: PORT }), { mode: 0o600 });
console.log(`claude-os ready http://127.0.0.1:${PORT}/auth?token=${token}`);

// The window can close while a turn is running. The server stays up until nothing needs it.
if (IDLE_EXIT_MS > 0) {
  let idleSince = Date.now();
  setInterval(() => {
    if (sockets.size > 0 || busy.size > 0) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_EXIT_MS) shutdown();
  }, 30_000).unref();
}

function shutdown() {
  rmSync(runtimeFile, { force: true });
  process.exit(0);
}

async function restart() {
  for (const ws of sockets.values()) ws.terminate();
  await app.close(); // the port must be free before the next process binds it
  // The SDK gives a stopped process seconds before it kills it. Still alive, it would hold its session in the registry
  // when the next server goes on with the turn there. Nothing here may stop the restart itself.
  await endClaudeChildren(process.pid).catch((err: Error) => console.warn('ending children before restart:', err.message));
  const log = openSync(join(paths.data, 'server.log'), 'a');
  spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { cwd: paths.repo, detached: true, stdio: ['ignore', log, log] }).unref();
  shutdown();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
mkdirSync(paths.config, { recursive: true });
