// Reads journals from remembered offsets into SQLite. Everything here is idempotent: a re-read file changes nothing.
import { readFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { IndexStatus } from '../../shared/contract.ts';
import { getMeta, localDay, setMeta } from './db.ts';
import { LineSplitter, parseLine, type RecordFacts, type ToolCallFact, type UsageFact } from './parse.ts';
import { classifyUsage, INSERT_USAGE, osChangeLevel, type OsRoots, type UsageRoots } from './usage.ts';

const CHUNK = 2 * 1024 * 1024;
const RECENT_MS = 2 * 86_400_000;
const WARN_MIN_RECORDS = 200;
const WARN_SHARE = 0.05;

export interface JournalFile { session: string; agent: string | null; }

// <dir>/<session>.jsonl and <dir>/<session>/subagents/**/agent-*.jsonl. Anything else (workflow journal.jsonl) is not a transcript.
export function classifyJournal(projectsDir: string, path: string): JournalFile | null {
  if (!path.endsWith('.jsonl')) return null;
  const parts = relative(projectsDir, path).split(sep);
  if (parts.length === 2 && !parts[1].startsWith('agent-')) return { session: parts[1].slice(0, -6), agent: null };
  const name = parts.at(-1)!;
  if (parts.length >= 4 && parts[2] === 'subagents' && name.startsWith('agent-')) {
    return { session: parts[1], agent: name.slice('agent-'.length, -'.jsonl'.length) };
  }
  return null;
}

export const SKIP_DIRS = new Set(['tool-results', 'memory']);

interface Batch {
  usage: (UsageFact & { ts: number | null; sidechain: boolean })[];
  tools: (ToolCallFact & { ts: number | null })[];
  first: number | null;
  last: number | null;
  cwd: string | null;
  kind: string | null;
  title: string | null;
  lastPrompt: string | null;
  agentName: string | null;
  cost: number | null;
  version: string | null;
  versionTs: number;
  total: number;
  unknown: Map<string, number>;
}

function newBatch(): Batch {
  return {
    usage: [], tools: [], first: null, last: null, cwd: null, kind: null, title: null, lastPrompt: null,
    agentName: null, cost: null, version: null, versionTs: 0, total: 0, unknown: new Map(),
  };
}

function absorb(b: Batch, f: RecordFacts, isAgent: boolean): void {
  b.total++;
  if (!f.known) b.unknown.set(f.type, (b.unknown.get(f.type) ?? 0) + 1);
  if (f.ts !== null) {
    if (b.first === null || f.ts < b.first) b.first = f.ts;
    if (b.last === null || f.ts > b.last) b.last = f.ts;
  }
  b.cwd ??= f.cwd;
  if (f.kind && (b.kind === null || b.kind === 'interactive')) b.kind = f.kind;
  if (f.version && (f.ts ?? 0) >= b.versionTs) {
    b.version = f.version;
    b.versionTs = f.ts ?? 0;
  }
  if (f.usage) b.usage.push({ ...f.usage, ts: f.ts, sidechain: f.sidechain });
  for (const t of f.tools) b.tools.push({ ...t, ts: f.ts });
  if (isAgent) return; // titles and costs of a subagent are not the session's
  if (f.titles) {
    b.title = f.titles.title ?? b.title;
    b.lastPrompt = f.titles.lastPrompt ?? b.lastPrompt;
    b.agentName = f.titles.agentName ?? b.agentName;
  }
  if (f.costUsd !== null) b.cost = b.cost === null ? f.costUsd : Math.max(b.cost, f.costUsd);
}

export interface IndexerOpts {
  db: DatabaseSync;
  projectsDir: string;
  projectForCwd(cwd: string): string | null;
  onCommit(firstScan: boolean): void; // data changed
  usageRoots?: UsageRoots; // absent: no usage log
  osRoots?: OsRoots; // absent: no marks of who changed Claude OS
}

export function createIndexer({ db, projectsDir, projectForCwd, onCommit, usageRoots, osRoots }: IndexerOpts) {
  const upsertUsage = db.prepare(`
    INSERT INTO usage_messages (message_id, session, agent_id, ts, day, model, is_subagent, input, output, cache_read, cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      session = CASE WHEN is_subagent = 1 AND excluded.is_subagent = 0 THEN excluded.session ELSE session END,
      agent_id = CASE WHEN is_subagent = 1 AND excluded.is_subagent = 0 THEN NULL ELSE agent_id END,
      is_subagent = MIN(is_subagent, excluded.is_subagent),
      ts = CASE WHEN ts IS NULL OR excluded.ts < ts THEN excluded.ts ELSE ts END,
      day = CASE WHEN ts IS NULL OR excluded.ts < ts THEN excluded.day ELSE day END,
      input = MAX(input, excluded.input), output = MAX(output, excluded.output),
      cache_read = MAX(cache_read, excluded.cache_read), cache_write = MAX(cache_write, excluded.cache_write)
  `);
  const insertTool = db.prepare('INSERT OR IGNORE INTO tool_calls (id, name, skill, session, ts) VALUES (?, ?, ?, ?, ?)');
  const insertUsage = db.prepare(INSERT_USAGE);
  function logUsage(t: ToolCallFact & { ts: number | null }, session: string): void {
    const fact = usageRoots ? classifyUsage(t, usageRoots) : null;
    if (fact) insertUsage.run(t.id, session, t.name, fact.target, fact.kind, fact.op, t.ts);
    logOsChange(t, session);
  }
  const insertOsChange = db.prepare('INSERT OR IGNORE INTO os_changes (tool_id, session, path, level, ts) VALUES (?, ?, ?, ?, ?)');
  function logOsChange(t: ToolCallFact & { ts: number | null }, session: string): void {
    const level = osRoots ? osChangeLevel(t, osRoots) : null;
    if (level) insertOsChange.run(t.id, session, t.path, level, t.ts);
  }
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, project, cwd, kind, name, title, last_prompt, first_activity, last_activity, cost_usd, version)
    VALUES (?, ?, COALESCE(?, ''), COALESCE(?, 'interactive'), ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(project, excluded.project),
      cwd = CASE WHEN cwd = '' THEN excluded.cwd ELSE cwd END,
      name = COALESCE(excluded.name, name),
      title = COALESCE(excluded.title, title),
      last_prompt = COALESCE(excluded.last_prompt, last_prompt),
      first_activity = MIN(COALESCE(first_activity, excluded.first_activity), COALESCE(excluded.first_activity, first_activity)),
      last_activity = MAX(COALESCE(last_activity, excluded.last_activity), COALESCE(excluded.last_activity, last_activity)),
      cost_usd = MAX(COALESCE(cost_usd, excluded.cost_usd), COALESCE(excluded.cost_usd, cost_usd)),
      version = COALESCE(excluded.version, version),
      removed = 0
  `);
  const setKind = db.prepare("UPDATE sessions SET kind = ? WHERE id = ? AND kind = 'interactive'");
  const upsertAgent = db.prepare(`
    INSERT INTO subagents (session, id, agent_type, description, last_activity) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session, id) DO UPDATE SET
      agent_type = COALESCE(excluded.agent_type, agent_type),
      description = COALESCE(excluded.description, description),
      last_activity = MAX(COALESCE(last_activity, excluded.last_activity), COALESCE(excluded.last_activity, last_activity))
  `);
  const getProject = db.prepare('SELECT project FROM sessions WHERE id = ?');
  const getOffset = db.prepare('SELECT offset FROM file_offsets WHERE path = ?');
  const putOffset = db.prepare('INSERT OR REPLACE INTO file_offsets (path, offset) VALUES (?, ?)');
  const bumpUnknown = db.prepare(`
    INSERT INTO unknown_records (type, count, first_seen, last_seen, version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET count = count + excluded.count, last_seen = excluded.last_seen, version = COALESCE(excluded.version, version)
  `);
  const bumpStats = db.prepare(`
    INSERT INTO record_stats (day, total, unknown) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET total = total + excluded.total, unknown = unknown + excluded.unknown
  `);
  const recentStats = db.prepare('SELECT COALESCE(SUM(total), 0) total, COALESCE(SUM(unknown), 0) unknown FROM record_stats WHERE day >= ?');

  let filesTotal = 0;
  let filesDone = 0;
  let firstScan = true;
  let stopped = false;
  let sweeping = false;
  let running: Promise<void> | null = null;
  let backlog: string[] = [];
  const urgent = new Set<string>();
  let claudeVersion = getMeta(db, 'claude_version');
  let versionTs = Number(getMeta(db, 'claude_version_ts') ?? 0);

  function commit(file: JournalFile, path: string, b: Batch, offset: number, mtimeMs: number): void {
    const now = Date.now();
    const unknownCount = [...b.unknown.values()].reduce((a, n) => a + n, 0);
    db.exec('BEGIN');
    try {
      const isSub = file.agent !== null;
      for (const u of b.usage) {
        upsertUsage.run(
          u.messageId, file.session, file.agent, u.ts, u.ts === null ? null : localDay(u.ts), u.model,
          isSub || u.sidechain ? 1 : 0, u.input, u.output, u.cacheRead, u.cacheWrite,
        );
      }
      for (const t of b.tools) {
        insertTool.run(t.id, t.name, t.skill, file.session, t.ts);
        logUsage(t, file.session);
      }
      if (b.total > 0) {
        // A session is one project: later cwds (cd into a subdir, a subagent's worktree) must not create more.
        const hasProject = (getProject.get(file.session) as { project: string | null } | undefined)?.project;
        const project = !hasProject && b.cwd ? projectForCwd(b.cwd) : null;
        upsertSession.run(file.session, project, b.cwd, b.kind, b.agentName, b.title, b.lastPrompt, b.first, b.last, b.cost, isSub ? null : b.version);
        if (b.kind && b.kind !== 'interactive') setKind.run(b.kind, file.session);
        if (file.agent) upsertAgent.run(file.session, file.agent, null, null, b.last);
      }
      for (const [type, n] of b.unknown) bumpUnknown.run(type, n, now, now, b.version);
      // Only fresh files feed the warning: years of old formats must not raise it on a first scan.
      if (b.total > 0 && now - mtimeMs < RECENT_MS) bumpStats.run(localDay(now), b.total, unknownCount);
      if (b.version && b.versionTs >= versionTs) {
        versionTs = b.versionTs;
        claudeVersion = b.version;
        setMeta(db, 'claude_version', claudeVersion);
        setMeta(db, 'claude_version_ts', String(versionTs));
      }
      putOffset.run(path, offset);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function readMeta(file: JournalFile, path: string): void {
    if (!file.agent) return;
    try {
      const meta = JSON.parse(readFileSync(`${path.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8')) as { agentType?: unknown; description?: unknown };
      upsertAgent.run(
        file.session, file.agent,
        typeof meta.agentType === 'string' ? meta.agentType : null,
        typeof meta.description === 'string' ? meta.description : null,
        null,
      );
    } catch { /* the meta file comes a moment later or never */ }
  }

  async function indexFile(path: string): Promise<void> {
    const file = classifyJournal(projectsDir, path);
    if (!file) return;
    const st = await stat(path);
    const row = getOffset.get(path) as { offset: number } | undefined;
    let offset = row?.offset ?? 0;
    if (st.size < offset) offset = 0; // rewritten: read again, upserts do not double count
    if (st.size === offset) return;
    if (offset === 0) readMeta(file, path);
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      const splitter = new LineSplitter();
      let pos = offset;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
        if (bytesRead === 0 || stopped) break;
        pos += bytesRead;
        const batch = newBatch();
        splitter.feed(buf.subarray(0, bytesRead), (b, s, e) => absorb(batch, parseLine(b, s, e), file.agent !== null));
        // An unterminated last line stays unread: the offset stops before it.
        commit(file, path, batch, pos - splitter.pendingBytes, st.mtimeMs);
        onCommit(firstScan);
        await yieldLoop();
      }
    } finally {
      await fh.close();
    }
  }

  async function walk(dir: string, out: { path: string; mtime: number; size: number }[]): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p, out);
      } else if (e.isFile() && classifyJournal(projectsDir, p)) {
        try {
          const st = await stat(p);
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch { /* deleted between readdir and stat */ }
      }
    }
  }

  async function run(): Promise<void> {
    await yieldLoop();
    while (!stopped) {
      const fromUrgent = urgent.values().next().value as string | undefined;
      const path = fromUrgent ?? backlog.shift();
      if (!path) break;
      if (fromUrgent) urgent.delete(fromUrgent);
      try {
        await indexFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('journal index', path, err);
      }
      if (!fromUrgent) filesDone++;
    }
  }

  function drain(): Promise<void> {
    running ??= run().finally(() => { running = null; });
    return running;
  }

  async function sweepOnce(): Promise<void> {
    const found: { path: string; mtime: number; size: number }[] = [];
    await walk(projectsDir, found);
    if (stopped) return;
    // Main files first, so a session gets its project from its own cwd and not from a subagent's worktree.
    const rank = (p: string) => (classifyJournal(projectsDir, p)?.agent ? 1 : 0);
    found.sort((a, b) => rank(a.path) - rank(b.path) || b.mtime - a.mtime);
    filesTotal = found.length;
    filesDone = 0;
    backlog = [];
    for (const f of found) {
      const row = getOffset.get(f.path) as { offset: number } | undefined;
      if (row?.offset === f.size) filesDone++;
      else backlog.push(f.path);
    }
    await drain();
    if (!firstScan) return;
    firstScan = false;
    onCommit(false);
  }

  // Journals read before the usage log existed. Offsets stay as they are: a parser bump would re-count the
  // format statistics and re-read 14 GB through JSON. Only assistant lines naming memory are parsed here.
  let backfilling = false;
  async function backfillUsage(): Promise<void> {
    backfilling = true;
    try {
      if (usageRoots && getMeta(db, 'usage_backfill') !== '1') {
        db.exec(`INSERT OR IGNORE INTO usage_log (tool_id, session, tool, target, kind, op, ts)
          SELECT id, session, name, skill, 'skill', 'use', ts FROM tool_calls WHERE skill IS NOT NULL`);
        await replayToolCalls([Buffer.from('/memory'), Buffer.from(usageRoots.vault)], () => true, logUsage);
        if (!stopped) setMeta(db, 'usage_backfill', '1');
      }
      // Only sessions that ran in this repository: nearly all such edits are there, and it spares reading every journal again.
      if (osRoots && getMeta(db, 'os_changes_backfill') !== '1') {
        const cwdOf = db.prepare('SELECT cwd FROM sessions WHERE id = ?');
        const prefix = `${osRoots.repo}/`;
        const inRepo = (session: string) => {
          const cwd = (cwdOf.get(session) as { cwd: string } | undefined)?.cwd;
          return !!cwd && (cwd === osRoots.repo || cwd.startsWith(prefix));
        };
        await replayToolCalls([Buffer.from(prefix), Buffer.from(osRoots.config)], inRepo, logOsChange);
        if (!stopped) setMeta(db, 'os_changes_backfill', '1');
      }
    } finally {
      backfilling = false;
    }
  }

  async function replayToolCalls(needles: Buffer[], wanted: (session: string) => boolean, log: (t: ToolCallFact & { ts: number | null }, session: string) => void): Promise<void> {
    const toolUse = Buffer.from('"tool_use"');
    const found: { path: string; mtime: number; size: number }[] = [];
    await walk(projectsDir, found);
    const buf = Buffer.allocUnsafe(CHUNK);
    for (const { path } of found) {
      if (stopped) return;
      const file = classifyJournal(projectsDir, path);
      if (!file || !wanted(file.session)) continue;
      const fh = await open(path, 'r').catch(() => null);
      if (!fh) continue;
      try {
        const splitter = new LineSplitter();
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
          if (bytesRead === 0 || stopped) break;
          db.exec('BEGIN');
          try {
            splitter.feed(buf.subarray(0, bytesRead), (b, s, e) => {
              const line = b.subarray(s, e);
              if (!line.includes(toolUse) || !needles.some((n) => line.includes(n))) return;
              const facts = parseLine(b, s, e);
              for (const t of facts.tools) log({ ...t, ts: facts.ts }, file.session);
            });
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
          await yieldLoop();
        }
      } finally {
        await fh.close();
      }
    }
  }

  return {
    backfillUsage,
    isBackfilling: () => backfilling,
    enqueue(path: string): void {
      if (stopped || !classifyJournal(projectsDir, path)) return;
      urgent.add(path);
      void drain();
    },
    refreshMeta(metaPath: string): void {
      const path = `${metaPath.slice(0, -'.meta.json'.length)}.jsonl`;
      const file = classifyJournal(projectsDir, path);
      if (file) readMeta(file, path);
      onCommit(false);
    },
    // Walks the tree and reads whatever grew. The newest go first, so recent numbers appear within seconds.
    async sweep(): Promise<void> {
      if (sweeping) return; // a first scan can outlive the sweep interval
      sweeping = true;
      try {
        await sweepOnce();
      } finally {
        sweeping = false;
      }
    },
    status(): IndexStatus {
      const r = recentStats.get(localDay(Date.now() - RECENT_MS)) as { total: number; unknown: number };
      const share = r.total > 0 ? r.unknown / r.total : 0;
      const warn = r.total >= WARN_MIN_RECORDS && share >= WARN_SHARE;
      return {
        filesTotal,
        filesDone,
        indexing: firstScan,
        unknownRecordShare: share,
        formatWarning: warn
          ? `The journal format may have changed: ${Math.round(share * 100)}% of recent records were not recognised (Claude Code ${claudeVersion ?? 'version unknown'})`
          : null,
        ...(warn ? { formatWarningKey: claudeVersion ? 'journalFormat' : 'journalFormatNoVersion', formatWarningParams: { share: Math.round(share * 100), version: claudeVersion ?? '' } } : {}),
        claudeVersion,
      };
    },
    idle(): Promise<void> {
      return running ?? Promise.resolve();
    },
    stop(): Promise<void> {
      stopped = true;
      return running ?? Promise.resolve();
    },
  };
}

export type Indexer = ReturnType<typeof createIndexer>;
