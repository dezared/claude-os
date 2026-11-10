// The one module that understands Claude Code's undocumented jsonl. Nothing else touches record fields.
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { ChatBlock, ChatEvent } from '../../shared/contract.ts';
import { stripPastedTags } from '../../shared/pasted.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ChatEventBody = DistributiveOmit<ChatEvent, 'seq' | 'at'>;

export const KNOWN_TYPES = new Set([
  'assistant', 'user', 'system', 'attachment', 'queue-operation', 'api-request', 'api-request-blob', 'api-request-shape',
  'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'ai-title', 'agent-name', 'tools-used', 'file-history-snapshot',
  'file-history-delta', 'session-owner', 'bridge-session', 'frame-link', 'cost-state', 'artifact-comment-monitor',
  'artifact-autoreact-ledger', 'fork-context-ref', 'continued-in', 'pr-link', 'worktree-state',
]);

const SYNTHETIC = '<synthetic>';
const TOOL_RESULT_CLIP = 50_000;
const PROMPT_CLIP = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface UsageFact {
  messageId: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolCallFact { id: string; name: string; skill: string | null; path: string | null; }

export interface Titles { title: string | null; lastPrompt: string | null; agentName: string | null; }

export interface RecordFacts {
  type: string;
  known: boolean;
  ts: number | null;
  cwd: string | null;
  version: string | null;
  kind: string | null; // interactive | background | sdk
  sidechain: boolean;
  usage: UsageFact | null;
  tools: ToolCallFact[];
  titles: Titles | null;
  costUsd: number | null;
}

// One API response is several records with one message.id: the caller merges with MAX per field.
export function parseUsage(rec: unknown): UsageFact | null {
  if (!isObj(rec) || rec.type !== 'assistant' || !isObj(rec.message)) return null;
  const m = rec.message;
  const id = str(m.id);
  if (!id || m.model === SYNTHETIC || !isObj(m.usage)) return null;
  const u = m.usage;
  return {
    messageId: id,
    model: str(m.model),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

export function parseToolCalls(rec: unknown): ToolCallFact[] {
  if (!isObj(rec) || rec.type !== 'assistant' || !isObj(rec.message) || !Array.isArray(rec.message.content)) return [];
  const out: ToolCallFact[] = [];
  for (const b of rec.message.content) {
    if (!isObj(b) || b.type !== 'tool_use') continue;
    const id = str(b.id), name = str(b.name);
    if (!id || !name) continue;
    const input = isObj(b.input) ? b.input : {};
    out.push({ id, name, skill: name === 'Skill' ? str(input.skill) : null, path: str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) });
  }
  return out;
}

export function parseTitles(rec: unknown): Titles | null {
  if (!isObj(rec)) return null;
  const titles = (t: Partial<Titles>): Titles => ({ title: null, lastPrompt: null, agentName: null, ...t });
  if (rec.type === 'ai-title') return titles({ title: str(rec.aiTitle) });
  if (rec.type === 'agent-name') return titles({ agentName: str(rec.agentName) });
  if (rec.type === 'last-prompt') {
    const p = str(rec.lastPrompt); // often absent: only leafUuid
    return p ? titles({ lastPrompt: stripPastedTags(p).slice(0, PROMPT_CLIP) }) : null; // a pasted block reads as its text
  }
  return null;
}

// totalCostUSD is the API-equivalent cost of the whole session, cumulative.
export function parseCost(rec: unknown): number | null {
  if (!isObj(rec) || rec.type !== 'cost-state' || typeof rec.totalCostUSD !== 'number') return null;
  return rec.totalCostUSD;
}

function kindOf(rec: Obj): string | null {
  const entry = str(rec.entrypoint);
  if (entry?.includes('sdk')) return 'sdk';
  if (rec.sessionKind === 'bg') return 'background';
  return entry ? 'interactive' : null;
}

const EMPTY_FACTS: Omit<RecordFacts, 'type' | 'known'> = {
  ts: null, cwd: null, version: null, kind: null, sidechain: false, usage: null, tools: [], titles: null, costUsd: null,
};

export function parseRecord(rec: unknown): RecordFacts {
  if (!isObj(rec) || typeof rec.type !== 'string') return { ...EMPTY_FACTS, type: '<no-type>', known: false };
  const type = rec.type;
  if (!KNOWN_TYPES.has(type)) return { ...EMPTY_FACTS, type: type.slice(0, 64), known: false };
  const usage = parseUsage(rec);
  // A real assistant record without usage means the format moved: that must show up in the unknown share.
  const known = type !== 'assistant' || usage !== null || (isObj(rec.message) && rec.message.model === SYNTHETIC);
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  return {
    type: known ? type : 'assistant:no-usage',
    known,
    ts: Number.isNaN(ts) ? null : ts,
    cwd: str(rec.cwd),
    version: str(rec.version),
    kind: kindOf(rec),
    sidechain: rec.isSidechain === true,
    usage,
    tools: parseToolCalls(rec),
    titles: parseTitles(rec),
    costUsd: parseCost(rec),
  };
}

const API_REQUEST_PREFIX = Buffer.from('{"type":"api-request');
const USER_HEAD = '"type":"user","message":';
const BIG_USER_LINE = 8 * 1024;

// 13+ GB on a real machine, three quarters of it inside user records (tool results) and api-request blobs.
// Neither holds anything the index needs, so the big ones are recognised by their head without JSON.parse.
export function parseLine(buf: Buffer, start: number, end: number): RecordFacts {
  const prefixEnd = start + API_REQUEST_PREFIX.length;
  if (prefixEnd <= end && buf.compare(API_REQUEST_PREFIX, 0, API_REQUEST_PREFIX.length, start, prefixEnd) === 0) {
    return { ...EMPTY_FACTS, type: 'api-request', known: true };
  }
  if (end - start > BIG_USER_LINE && buf.toString('latin1', start, start + 400).includes(USER_HEAD)) {
    return { ...EMPTY_FACTS, type: 'user', known: true };
  }
  try {
    return parseRecord(JSON.parse(buf.toString('utf8', start, end)));
  } catch {
    return { ...EMPTY_FACTS, type: '<invalid-json>', known: false };
  }
}

// Splits a stream of chunks into complete lines. `pendingBytes` is the unfinished tail, not yet consumed.
export class LineSplitter {
  pendingBytes = 0;
  private pending: Buffer[] = [];

  feed(chunk: Buffer, onLine: (buf: Buffer, start: number, end: number) => void): void {
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
      if (this.pendingBytes > 0) {
        const whole = Buffer.concat([...this.pending, chunk.subarray(start, nl)]);
        this.pending = [];
        this.pendingBytes = 0;
        onLine(whole, 0, whole.length);
      } else if (nl > start) {
        onLine(chunk, start, nl);
      }
      start = nl + 1;
    }
    if (start < chunk.length) {
      this.pending.push(Buffer.from(chunk.subarray(start))); // the caller reuses its read buffer
      this.pendingBytes += chunk.length - start;
    }
  }
}

// ---------- Chat events ----------

function toolResultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((b) => {
      if (!isObj(b)) return '';
      if (b.type === 'text') return str(b.text) ?? '';
      return b.type === 'image' ? '[image]' : '';
    }).join('\n');
  }
  return text.length > TOOL_RESULT_CLIP ? `${text.slice(0, TOOL_RESULT_CLIP)}\n…[clipped, ${text.length} chars]` : text;
}

function assistantBlocks(content: unknown, subagent: string | null): ChatBlock[] {
  if (!Array.isArray(content)) return typeof content === 'string' && content ? [{ type: 'text', text: content }] : [];
  const blocks: ChatBlock[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && str(b.text)) blocks.push({ type: 'text', text: b.text as string });
    // Thinking is usually stored as a bare signature with empty text.
    else if (b.type === 'thinking' && str(b.thinking)) blocks.push({ type: 'thinking', text: b.thinking as string });
    else if (b.type === 'tool_use' && str(b.id) && str(b.name)) {
      blocks.push({ type: 'tool_use', id: b.id as string, name: b.name as string, input: b.input ?? null, subagent });
    }
  }
  return blocks;
}

const tagText = (text: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.replace(/\x1b\[[0-9;]*m/g, '').trim() ?? '';

// Claude Code journals what it injects as ordinary user text; a person typed none of this.
function injectedEvents(raw: string): ChatEventBody[] | null {
  const text = raw.trimStart();
  const notice = (s: string): ChatEventBody[] => (s ? [{ e: 'warning', text: toolResultText(s) }] : []);
  const typed = (s: string): ChatEventBody[] => (s ? [{ e: 'user', blocks: [{ type: 'text', text: s }] }] : []);
  if (text.startsWith('<task-notification>')) return notice(tagText(text, 'summary'));
  if (/^<command-(name|message)>/.test(text)) return typed(`${tagText(text, 'command-name')} ${tagText(text, 'command-args')}`.trim());
  if (text.startsWith('<local-command-stdout>')) return notice(tagText(text, 'local-command-stdout'));
  if (text.startsWith('<bash-input>')) return typed(`! ${tagText(text, 'bash-input')}`);
  if (text.startsWith('<bash-stdout>')) return notice([tagText(text, 'bash-stdout'), tagText(text, 'bash-stderr')].filter(Boolean).join('\n'));
  if (text.startsWith('[Request interrupted by user')) return [{ e: 'warning', text: 'Interrupted', key: 'interrupted' }];
  return null;
}

const unwrapPasted = (text: string): string =>
  text.replace(/<pasted_content id="[^"]*">\n?/g, '').replace(/\n?<\/pasted_content id="[^"]*">/g, '');

function userEvents(content: unknown): ChatEventBody[] {
  if (typeof content === 'string') return userEvents([{ type: 'text', text: content }]);
  if (!Array.isArray(content)) return [];
  const out: ChatEventBody[] = [];
  const blocks: ChatBlock[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result' && str(b.tool_use_id)) {
      out.push({ e: 'tool_result', toolUseId: b.tool_use_id as string, text: toolResultText(b.content), isError: b.is_error === true });
    } else if (b.type === 'text' && str(b.text)) {
      const injected = injectedEvents(b.text as string);
      if (injected) out.push(...injected);
      else blocks.push({ type: 'text', text: unwrapPasted(b.text as string) });
    } else if (b.type === 'image' && isObj(b.source) && str(b.source.data)) {
      blocks.push({ type: 'image', mediaType: str(b.source.media_type) ?? 'image/png', base64: b.source.data as string });
    }
  }
  if (blocks.length) out.push({ e: 'user', blocks });
  return out;
}

// Assistant messages arrive split: several records share one messageId, one block each.
// So the same messageId means "append blocks"; readTranscript already merges neighbours.
export function recordToChatEvents(rec: unknown): ChatEventBody[] {
  if (!isObj(rec)) return [];
  if (rec.type === 'assistant' && isObj(rec.message)) {
    const m = rec.message;
    if (rec.isApiErrorMessage === true) {
      const text = assistantBlocks(m.content, null).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return [{ e: 'error', text: text || 'API error' }];
    }
    const blocks = assistantBlocks(m.content, str(rec.agentId) ?? str(rec.parent_tool_use_id));
    if (!blocks.length) return [];
    return [{ e: 'assistant', messageId: str(m.id) ?? str(rec.uuid) ?? '', blocks, model: m.model === SYNTHETIC ? null : str(m.model) }];
  }
  if (rec.type === 'user' && isObj(rec.message)) {
    if (rec.isMeta === true || rec.isCompactSummary === true) return [];
    return userEvents(rec.message.content);
  }
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') return [{ e: 'warning', text: 'Context compacted', key: 'compacted' }];
  return [];
}

class TranscriptBuilder {
  events: ChatEvent[] = [];
  private seen = new Set<string>();
  private lastAt = 0;

  add(buf: Buffer, start: number, end: number): void {
    if (end - start >= API_REQUEST_PREFIX.length && buf.compare(API_REQUEST_PREFIX, 0, API_REQUEST_PREFIX.length, start, start + API_REQUEST_PREFIX.length) === 0) return;
    let rec: unknown;
    try { rec = JSON.parse(buf.toString('utf8', start, end)); } catch { return; }
    if (!isObj(rec) || rec.isSidechain === true) return;
    const uuid = str(rec.uuid);
    if (uuid) {
      if (this.seen.has(uuid)) return;
      this.seen.add(uuid);
    }
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) this.lastAt = ts;
    for (const body of recordToChatEvents(rec)) {
      const last = this.events.at(-1);
      if (body.e === 'assistant' && last?.e === 'assistant' && last.messageId === body.messageId) {
        last.blocks.push(...body.blocks);
        continue;
      }
      this.events.push({ ...body, seq: this.events.length + 1, at: this.lastAt } as ChatEvent);
    }
  }
}

export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function findJournal(sessionId: string, cwd: string | null, claudeDir: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null; // the id ends up in a path
  const projects = join(claudeDir, 'projects');
  if (cwd) {
    const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const p = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const CHUNK = 2 * 1024 * 1024;

export function readTranscript(sessionId: string, cwd: string | null, claudeDir = defaultClaudeDir()): ChatEvent[] {
  const path = findJournal(sessionId, cwd, claudeDir);
  if (!path) return [];
  const builder = new TranscriptBuilder();
  const splitter = new LineSplitter();
  const onLine = (b: Buffer, s: number, e: number) => builder.add(b, s, e);
  const buf = Buffer.allocUnsafe(CHUNK);
  const fd = openSync(path, 'r');
  try {
    for (let n = readSync(fd, buf, 0, CHUNK, null); n > 0; n = readSync(fd, buf, 0, CHUNK, null)) splitter.feed(buf.subarray(0, n), onLine);
  } finally {
    closeSync(fd);
  }
  return builder.events;
}

// For the REST route: journals reach hundreds of MB, so it gives the event loop a turn between chunks.
export async function readTranscriptAsync(path: string): Promise<ChatEvent[]> {
  const builder = new TranscriptBuilder();
  const splitter = new LineSplitter();
  const onLine = (b: Buffer, s: number, e: number) => builder.add(b, s, e);
  const buf = Buffer.allocUnsafe(CHUNK);
  const fh = await open(path, 'r');
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      splitter.feed(buf.subarray(0, bytesRead), onLine);
      await yieldLoop();
    }
  } finally {
    await fh.close();
  }
  return builder.events;
}
