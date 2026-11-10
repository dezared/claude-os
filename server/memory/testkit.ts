// Shared by server/memory and server/tools tests: a Ctx over temp dirs. Nothing here touches real data.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Project, ServerMessage, SessionInfo, Topic } from '../../shared/contract.ts';
import type { Ctx, JournalApi, Paths } from '../context.ts';

export interface TestKit {
  ctx: Ctx;
  app: FastifyInstance;
  paths: Paths;
  base: string;
  audits: { action: string; target: string; diff: string | null }[];
  topics: Topic[];
  messages: ServerMessage[];
  projects: Project[];
  sessions: SessionInfo[];
  addProject(key: string, root: string): Project;
  write(path: string, text: string): string;
  close(): Promise<void>;
}

export function makeKit(journal?: Partial<JournalApi>): TestKit {
  const base = mkdtempSync(join(tmpdir(), 'claude-os-test-'));
  const paths: Paths = {
    repo: base,
    data: join(base, 'data'),
    config: join(base, 'config'),
    plugins: join(base, 'plugins'),
    root: join(base, 'root'),
    service: join(base, 'service'),
    setup: join(base, 'setup'),
    claudeDir: join(base, 'claude'),
    claudeJson: join(base, 'claude', '.claude.json'),
    claudeBin: join(base, 'bin', 'claude'),
    vault: join(base, 'vault'),
    newProjectsDir: join(base, 'new'),
  };
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.claudeDir, { recursive: true });
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });
  const audits: TestKit['audits'] = [];
  const topics: Topic[] = [];
  const messages: ServerMessage[] = [];
  const projects: Project[] = [];
  const sessions: SessionInfo[] = [];
  const ctx: Ctx = {
    journal: {
      listProjects: () => projects,
      listSessions: () => sessions,
      projectForCwd: (cwd) => projects.find((p) => p.root === cwd)?.key ?? null,
      markOsSession: () => {},
      setMapPin: () => null,
      updateProject: () => null,
      lostSessions: () => [],
      dismissLost: () => {},
      ...journal,
    },
    memory: null as unknown as Ctx['memory'],
    app,
    db: null as unknown as Ctx['db'],
    paths,
    bus: new EventEmitter(),
    broadcast: (m) => void messages.push(m),
    invalidate: (...t) => void topics.push(...t),
    audit: (action, target, diff = null) => void audits.push({ action, target, diff }),
    onClientMessage: () => {},
    onClientClose: () => {},
    setBusy: () => {},
  };
  return {
    ctx, app, paths, base, audits, topics, messages, projects, sessions,
    addProject(key, root) {
      mkdirSync(root, { recursive: true });
      const project: Project = { key, name: key, root, misc: false, sessionCount: 0, liveCount: 0, lastActivity: null, memoryCount: 0, memoryConnected: false, memoryDrift: 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false };
      projects.push(project);
      return project;
    },
    write(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    async close() {
      await app.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function session(id: string, project: string | null, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, project, cwd, kind: 'interactive', origin: 'external', name: null, title: null, lastPrompt: null,
    firstActivity: null, lastActivity: null, status: 'idle', pid: null,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, subagents: [],
    ...extra,
  };
}

export async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
