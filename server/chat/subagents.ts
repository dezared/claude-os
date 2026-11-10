// A subagent's journal as chat events: <session>/subagents/**/agent-<id>.jsonl, with the spawning call in agent-<id>.meta.json.
import { closeSync, createReadStream, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ActiveSubagent, ChatEvent, SubagentTranscript } from '../../shared/contract.ts';
import { recordToChatEvents } from '../journal/index.ts';
import { findJournal } from '../journal/parse.ts';

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

function agentFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return agentFiles(path);
    return e.isFile() && AGENT_FILE.test(e.name) ? [path] : [];
  });
}

function readMeta(journal: string): { agentType?: string; description?: string; toolUseId?: string; finished?: boolean } {
  try {
    return JSON.parse(readFileSync(journal.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function readEvents(path: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const seen = new Set<string>();
  let at = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    let rec: { uuid?: unknown; timestamp?: unknown };
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec.uuid === 'string') {
      if (seen.has(rec.uuid)) continue;
      seen.add(rec.uuid);
    }
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) at = ts;
    for (const body of recordToChatEvents(rec)) {
      // Inside its own view a subagent's calls are plain calls, not a nested group.
      const clean = body.e === 'assistant' ? { ...body, blocks: body.blocks.map((b) => (b.type === 'tool_use' ? { ...b, subagent: null } : b)) } : body;
      events.push({ ...clean, seq: events.length + 1, at } as ChatEvent);
    }
  }
  return events;
}

export async function readSubagent(sessionId: string, cwd: string | null, key: string, claudeDir: string): Promise<SubagentTranscript | null> {
  const journal = findJournal(sessionId, cwd, claudeDir);
  if (!journal) return null;
  const files = agentFiles(join(dirname(journal), sessionId, 'subagents'));
  const path = files.find((f) => f.endsWith(`/agent-${key}.jsonl`)) ?? files.find((f) => readMeta(f).toolUseId === key);
  if (!path) return null;
  const meta = readMeta(path);
  return {
    id: AGENT_FILE.exec(path.slice(path.lastIndexOf('/') + 1))![1],
    toolUseId: meta.toolUseId ?? null,
    agentType: meta.agentType ?? null,
    description: meta.description ?? null,
    lastActivity: statSync(path).mtimeMs,
    finished: meta.finished === true,
    events: await readEvents(path),
  };
}

const SILENT_MS = 120_000; // the same silence after which the space view's satellites count a subagent as stopped
const WINDOW = 64 * 1024; // a line of a journal can be huge, what the agent does now is in its last records

function readWindow(path: string, from: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, from));
  } finally {
    closeSync(fd);
  }
}

type Message = { type?: unknown; message?: { stop_reason?: unknown; content?: unknown } };

function lastRecords(path: string, size: number): Message[] {
  const from = Math.max(0, size - WINDOW);
  const lines = readWindow(path, from, size - from).split('\n');
  if (from > 0) lines.shift(); // starts in the middle of a line
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as Message]; } catch { return []; }
  });
}

function toolLine(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = [i.command, i.file_path, i.path, i.notebook_path, i.pattern, i.query, i.url, i.skill, i.description].find((v) => typeof v === 'string' && v) as string | undefined;
  return (arg ? `${name} ${arg.split('\n')[0]}` : name).slice(0, 200);
}

// What the journal says about the end: the CLI's mark on the meta file, or the agent's own final message.
function currentWork(records: Message[]): { ended: boolean; doing: string | null } {
  let ended = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type !== 'assistant') continue;
    if (i === records.length - 1 && (r.message?.stop_reason === 'end_turn' || r.message?.stop_reason === 'stop_sequence')) ended = true;
    const blocks = Array.isArray(r.message?.content) ? r.message.content as { type?: unknown; name?: unknown; input?: unknown }[] : [];
    const tool = blocks.findLast((b) => b.type === 'tool_use');
    if (tool) return { ended, doing: toolLine(String(tool.name), tool.input) };
  }
  return { ended, doing: null };
}

function startedAt(path: string, birth: number): number {
  // The journal's first timestamp; a first line longer than the window leaves the file's own birth.
  const match = /"timestamp":"([^"]+)"/.exec(readWindow(path, 0, WINDOW));
  const at = match ? Date.parse(match[1]) : NaN;
  return Number.isNaN(at) ? birth : at;
}

// The list is asked for on every poll of every open sessions screen: a journal is read again only after it or its meta changed.
const MAX_READ_CACHE = 20_000;
const readCache = new Map<string, { version: string; meta: ReturnType<typeof readMeta>; ended: boolean; doing: string | null; startedAt: number }>();

function readAgent(path: string, stat: Stats) {
  const metaStat = statSync(path.replace(/\.jsonl$/, '.meta.json'), { throwIfNoEntry: false });
  const version = `${stat.mtimeMs}:${stat.size}:${metaStat?.mtimeMs}:${metaStat?.size}`;
  const hit = readCache.get(path);
  if (hit?.version === version) return hit;
  const meta = readMeta(path);
  const entry = { version, meta, ...(meta.finished === true ? { ended: true, doing: null } : currentWork(lastRecords(path, stat.size))), startedAt: startedAt(path, stat.birthtimeMs) };
  if (readCache.size >= MAX_READ_CACHE) readCache.clear();
  readCache.set(path, entry);
  return entry;
}

/** Subagents at work now, for any session: a journal on disk is all a plain terminal gives. */
export function listActiveSubagents(sessionId: string, cwd: string | null, claudeDir: string, now = Date.now()): ActiveSubagent[] {
  const journal = findJournal(sessionId, cwd, claudeDir);
  if (!journal) return [];
  const out: ActiveSubagent[] = [];
  for (const path of agentFiles(join(dirname(journal), sessionId, 'subagents'))) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || now - stat.mtimeMs >= SILENT_MS) continue;
    const { meta, ended, doing, startedAt: started } = readAgent(path, stat);
    if (ended) continue;
    out.push({
      id: AGENT_FILE.exec(path.slice(path.lastIndexOf('/') + 1))![1],
      toolUseId: meta.toolUseId ?? null,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      startedAt: started,
      lastActivity: stat.mtimeMs,
      doing,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
