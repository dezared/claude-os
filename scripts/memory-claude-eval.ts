// Does Claude find what a 100k-note vault holds, and what does that cost the context? On a generated vault in a temp
// dir (never the user's vault, config or data): the sizes a session receives (prompt append, MEMORY.md, memory_search
// answers), then each question of memory-eval-vault.ts asked through the Agent SDK the way a work tab asks it, with
// only the memory_search tool of a throwaway memory module. Uses the signed-in Claude login and nothing else of the
// user's: no user settings, no session files (persistSession: false). Not part of the gate: it calls Claude.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-claude-eval.ts [notes, default 100000] [--measure] [--only 1,4]
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSdkMcpServer, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MEMORY_SEARCH_TOOL, ROOT_MCP_NAME } from '../server/chat/rootMcp.ts';
import { memorySearchTool } from '../server/chat/memoryTool.ts';
import { sessionProfileBlock } from '../server/chat/profile.ts';
import { sessionAppend } from '../server/chat/session.ts';
import { registerMemory, type MemoryApiExt } from '../server/memory/index.ts';
import { formatHits } from '../server/memory/search.ts';
import { makeKit, until, type TestKit } from '../server/memory/testkit.ts';
import { setWikiManaged } from '../server/memory/wikiManaged.ts';
import { MEMORY_BUDGET } from '../server/memory/wikiIndex.ts';
import { NEEDLES, noteText, PROJECTS, QUESTIONS, writeEvalVault, type Question } from './memory-eval-vault.ts';

const REPO = join(import.meta.dirname, '..');
// A rough token count for sizes no model call measured: about four bytes a token for English text.
const tokens = (bytes: number) => Math.round(bytes / 4);
const memoryPath = (kit: TestKit, key: string) => join(kit.paths.vault, 'projects', key, 'MEMORY.md');

export async function setUp(total: number): Promise<TestKit> {
  const kit = makeKit();
  for (const [key] of PROJECTS) kit.addProject(key, join(kit.base, 'work', key));
  const t = performance.now();
  const counts = writeEvalVault(kit.paths.vault, total);
  for (const [key] of PROJECTS) setWikiManaged(kit.paths, key, true);
  console.log(`vault: ${[...counts.values()].reduce((a, b) => a + b, 0)} notes (${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}), ${((performance.now() - t) / 1000).toFixed(1)} s`);
  registerMemory(kit.ctx);
  await (kit.ctx.memory as MemoryApiExt).ready;
  // MEMORY.md is regenerated the way a session's write regenerates it: the watcher sees a changed note.
  for (const n of NEEDLES.filter((x, i, all) => all.findIndex((y) => y.project === x.project) === i)) {
    writeFileSync(join(kit.paths.vault, 'projects', n.project, `${n.name}.md`), noteText(n));
  }
  await until(() => PROJECTS.every(([key]) => existsSync(memoryPath(kit, key)) && statSync(memoryPath(kit, key)).size > 0), 60_000);
  // The search index is written in steps between requests: wait until every needle is in.
  await until(() => NEEDLES.every((n) => kit.ctx.memory.search(n.name.replaceAll('-', ' '), { project: n.project, limit: 20 }).some((h) => h.name === n.name)), 300_000);
  return kit;
}

export function appendText(): string {
  const ctx = { paths: { root: join(REPO, 'root'), service: join(REPO, 'service'), setup: join(REPO, 'setup') }, settings: { profile: () => ({ name: 'Sam', language: 'en', questionLevel: 'balanced' }) } };
  return sessionAppend({ profile: sessionProfileBlock(ctx as never, 'work'), note: null, noteRules: readFileSync(join(REPO, 'root/NOTE_RULES.md'), 'utf8'), document: null, plugins: [] });
}

function measure(kit: TestKit): void {
  const append = Buffer.byteLength(appendText());
  console.log(`\nsession prompt append: ${append} B (~${tokens(append)} tokens)`);
  console.log(`MEMORY.md per project (budget ${MEMORY_BUDGET.lines} lines / ${MEMORY_BUDGET.bytes} B):`);
  for (const [key] of PROJECTS) {
    const text = readFileSync(memoryPath(kit, key), 'utf8');
    const lines = text.trimEnd().split('\n').length;
    const bytes = Buffer.byteLength(text);
    const ok = lines <= MEMORY_BUDGET.lines && bytes <= MEMORY_BUDGET.bytes;
    console.log(`  ${key.padEnd(14)} ${String(lines).padStart(4)} lines ${String(bytes).padStart(6)} B ~${tokens(bytes)} tokens ${ok ? 'within budget' : 'OVER BUDGET'}`);
  }
  console.log('memory_search answer for each question (the question as the query; rank: first needle note among the hits):');
  const needles = new Set(NEEDLES.map((n) => n.name));
  for (const q of QUESTIONS) {
    const row = [5, 20].map((limit) => {
      const t = performance.now();
      const hits = kit.ctx.memory.search(q.q, { limit, project: q.project, boost: q.project });
      const ms = performance.now() - t;
      const text = formatHits(hits);
      const rank = hits.findIndex((h) => needles.has(h.name)) + 1;
      return `limit ${limit}: ${Buffer.byteLength(text)} B ~${tokens(Buffer.byteLength(text))} tok ${ms.toFixed(0)} ms rank ${rank || '-'}`;
    });
    console.log(`  ${q.q.slice(0, 60).padEnd(60)} ${row.join(' | ')}`);
  }
}

export interface Outcome { calls: string[]; found: boolean; searches: number; reads: number; input: number; first: number; peak: number; output: number; turns: number; cost: number; model: string; toolBytes: number; answer: string }

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
const inputOf = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

// One model call's input is what the session holds at that point.
function toolCalls(m: SDKMessage, out: Outcome): void {
  if (m.type !== 'assistant') return;
  const context = inputOf(m.message.usage as Usage);
  out.first ||= context;
  out.peak = Math.max(out.peak, context);
  for (const b of m.message.content) {
    if (b.type !== 'tool_use') continue;
    const input = b.input as { query?: string; file_path?: string; pattern?: string };
    out.calls.push(`${b.name.replace(`mcp__${ROOT_MCP_NAME}__`, '')}(${input.query ?? input.file_path?.split('/').pop() ?? input.pattern ?? ''})`);
    if (b.name === MEMORY_SEARCH_TOOL) out.searches++;
    else out.reads++;
  }
}

function toolAnswers(m: SDKMessage, out: Outcome): void {
  if (m.type !== 'user' || !Array.isArray(m.message.content)) return;
  for (const b of m.message.content) if (typeof b === 'object' && b.type === 'tool_result') out.toolBytes += Buffer.byteLength(JSON.stringify(b.content ?? ''));
}

function result(m: SDKMessage, out: Outcome): void {
  if (m.type !== 'result') return;
  const u = m.usage as Usage;
  out.input = inputOf(u);
  out.output = u.output_tokens ?? 0;
  out.turns = m.num_turns;
  out.cost = m.total_cost_usd;
  out.answer = m.subtype === 'success' ? m.result : `(${m.subtype})`;
}

// Tool calls and their answers as the session saw them.
function tally(m: SDKMessage, out: Outcome): void {
  if (m.type === 'system' && m.subtype === 'init') out.model = m.model;
  toolCalls(m, out);
  toolAnswers(m, out);
  result(m, out);
}

// The child CLI must not join this process's own Claude Code session.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_?CODE|^CLAUDE_(PID|EFFORT|AGENT)/.test(k))) as Record<string, string>;

export async function ask(kit: TestKit, q: Question, append: string): Promise<Outcome> {
  const out: Outcome = { calls: [], found: false, searches: 0, reads: 0, input: 0, first: 0, peak: 0, output: 0, turns: 0, cost: 0, model: '', toolBytes: 0, answer: '' };
  const vault = kit.paths.vault;
  const reads = new Set(['Read', 'Grep', 'Glob']);
  const run = query({
    prompt: `${q.q}\nAnswer in one or two sentences.`,
    options: {
      cwd: join(kit.base, 'work', q.project),
      settingSources: [],
      persistSession: false,
      env: cleanEnv(),
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settings: { autoMemoryDirectory: join(vault, 'projects', q.project) },
      mcpServers: { [ROOT_MCP_NAME]: createSdkMcpServer({ name: ROOT_MCP_NAME, tools: [memorySearchTool(kit.ctx, q.project)] }) },
      strictMcpConfig: true,
      additionalDirectories: [vault],
      maxTurns: 12,
      // Reading notes is what a work tab may do; nothing here writes or runs commands.
      canUseTool: async (name, input) => (name === MEMORY_SEARCH_TOOL || (reads.has(name) && JSON.stringify(input).includes(kit.base))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Not available here: use memory_search and Read on note paths.' }),
    },
  });
  for await (const m of run) tally(m, out);
  out.found = q.expect.every((re) => re.test(out.answer));
  return out;
}

async function evaluate(kit: TestKit, only: number[] | null): Promise<void> {
  const append = appendText();
  const rows: string[] = ['| # | project | hop | found | memory_search | other tools | context at start | peak context | input tokens, all calls | tool answers | turns |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  let found = 0;
  let model = '';
  let cost = 0;
  const picked = QUESTIONS.map((q, i) => [q, i + 1] as const).filter(([, n]) => !only || only.includes(n));
  for (const [q, n] of picked) {
    const r = await ask(kit, q, append);
    model ||= r.model;
    cost += r.cost;
    if (r.found) found++;
    rows.push(`| ${n} | ${q.project} | ${q.hop ? 'yes' : ''} | ${r.found ? 'y' : 'n'} | ${r.searches} | ${r.reads} | ${r.first} | ${r.peak} | ${r.input} | ${(r.toolBytes / 1024).toFixed(1)} KB | ${r.turns} |`);
    console.log(`${n}. ${r.found ? 'FOUND' : 'MISSED'} ${q.q}\n   tools: ${r.calls.join(', ')}\n   -> ${r.answer.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  console.log(`\nmodel ${model}; found ${found}/${picked.length}; cost $${cost.toFixed(2)}\n${rows.join('\n')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const total = Number(args.find((a) => /^\d+$/.test(a)) ?? 100_000);
  const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const kit = await setUp(total);
  try {
    measure(kit);
    if (!args.includes('--measure')) await evaluate(kit, onlyArg ? onlyArg.split(',').map(Number) : null);
  } finally {
    await kit.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
