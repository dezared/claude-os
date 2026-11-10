#!/usr/bin/env node
// Stands in for `claude` in tests: speaks the stream-json control protocol the Agent SDK expects.
// The prompt text selects the scenario, see runTurn(). No network, no LLM.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const log = (entry) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n'); };

// The terminal UI of `claude /usage`: draws through escape sequences, needs a real TTY, lives until it is killed.
const screenCommand = argv.find((a) => a.startsWith('/'));
if (screenCommand && !argv.includes('stream-json')) {
  log({ kind: 'tui', argv, isTTY: process.stdout.isTTY === true, cols: process.stdout.columns });
  if (!process.stdout.isTTY) process.exit(2);
  const id = argv[argv.indexOf('--session-id') + 1];
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
  process.stdout.write('\x1b[2J\x1b[H\x1b[2mLoading\x1b[0m');
  setTimeout(() => process.stdout.write(`\x1b[2J\x1b[H\x1b[1mScreen of ${screenCommand}\x1b[0m\r\n\x1b[3;3HCurrent session: \x1b[38;5;114m12%\x1b[0m used\r\n`), 200);
  // The status screen of a real CLI, with what the card has to draw: its colours, a bar, a badge word, a file, a picture, a URL, a wide character.
  if (screenCommand === '/status') setTimeout(() => process.stdout.write('\r\n  日本語 \x1b[38;5;220mwide\x1b[0m\r\n  \x1b[38;5;153;48;5;102m█████     \x1b[0m 50% used\r\n  Search: OK\r\n  Edited src/a.ts:12 and shot.png\r\n  See https://example.com/docs.\r\n'), 400);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (argv[0] === 'doctor') { // prints its report and exits, with colours when it has a terminal
  log({ kind: 'tui', argv, isTTY: process.stdout.isTTY === true, cols: process.stdout.columns });
  process.stdout.write('\x1b[1mClaude Code doctor\x1b[0m\r\n\r\nRunning: native (2.1.318)\r\nNo installation issues found.\r\n');
  process.exit(0);
}

// `claude -p`, the one-shot /btw runs. Refuses what the real CLI refuses (its error texts), and the stdin text selects the scenario.
if (argv.includes('-p')) {
  const val = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const refuse = (text) => { process.stderr.write(`${text}\n`); process.exit(1); };
  log({ kind: 'print', pid: process.pid, argv, cwd: process.cwd() });
  if (argv.includes('--output-format') && val('--output-format') === 'stream-json' && !argv.includes('--verbose')) refuse('Error: When using --print, --output-format=stream-json requires --verbose');
  if (val('--session-id') && (argv.includes('--resume') || argv.includes('--continue')) && !argv.includes('--fork-session')) refuse('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.');
  let question = '';
  for await (const chunk of process.stdin) question += chunk;
  const resume = val('--resume');
  const session_id = argv.includes('--fork-session') || !resume ? val('--session-id') ?? randomUUID() : resume;
  const emit = (obj) => process.stdout.write(JSON.stringify({ session_id, parent_tool_use_id: null, ...obj }) + '\n');
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // What a run without the right flags would leave behind, for the tests to catch.
  if (!argv.includes('--no-session-persistence')) {
    const dir = join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${session_id}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session_id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: question } }) + '\n');
  }
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: val('--tools') === '' ? [] : [val('--tools')], mcp_servers: [] });
  const delta = (text) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  if (question.startsWith('BTWHOLD')) { // answers a little, then keeps going until it is killed
    delta('начало ответа ');
    for (;;) await pause(1000);
  }
  if (question.startsWith('BTWCRASH')) {
    process.stderr.write('fake side crash\n');
    process.exit(3);
  }
  if (question.startsWith('BTWFAIL')) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fake side failure'] });
    process.exit(1);
  }
  const answer = `${resume ? 'side' : 'plain'}: ${question}`;
  for (const part of answer.match(/.{1,4}/gs) ?? []) {
    delta(part);
    await pause(5);
  }
  emit({ type: 'assistant', message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text: answer }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: answer });
  process.exit(0);
}

if (!argv.includes('stream-json')) { // `claude agents --json`, `claude --version`...
  process.stdout.write(argv.includes('agents') ? '[]\n' : '2.1.318 (Claude Code)\n');
  process.exit(0);
}

log({ kind: 'spawn', pid: process.pid, argv, cwd: process.cwd() });

function flag(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] ?? null;
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

let sessionId = flag('--resume') ?? randomUUID();
const model = flag('--model') ?? 'fake-model';
const worktree = flag('--worktree');
const bypassAllowed = argv.includes('--allow-dangerously-skip-permissions');
let permissionMode = flag('--permission-mode') ?? 'auto';
const cwd = worktree ? join(process.cwd(), '.claude', 'worktrees', worktree) : process.cwd();
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => ({ uuid: randomUUID(), session_id: sessionId });

// FAKE_CLAUDE_REGISTRY: the entry the real CLI keeps in sessions/ while it runs. FAKE_CLAUDE_LINGER_MS: how long it
// stays after its input closes or a SIGTERM, as a real one busy finishing its work.
if (process.env.FAKE_CLAUDE_REGISTRY) {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId, cwd, status: 'idle', kind: 'interactive', entrypoint: 'sdk-ts', startedAt: Date.now(), updatedAt: Date.now() }));
}

function transcript(record) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ ...record, uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
}

let nextRequest = 1;
const waiting = new Map();
function controlRequest(request) {
  const request_id = `fake-${nextRequest++}`;
  write({ type: 'control_request', request_id, request });
  return new Promise((resolve, reject) => waiting.set(request_id, { resolve, reject }));
}

let interrupted = false;
const queue = [];
let running = false;

function init() {
  write({
    type: 'system', subtype: 'init', ...base(), cwd, model, tools: ['Read', 'Edit', 'Write'], mcp_servers: [], permissionMode,
    apiKeySource: 'none', claude_code_version: '2.1.318', output_style: 'default', skills: [], plugins: [],
    slash_commands: ['compact', 'cost', 'config', 'my-skill', 'odd-terminal'], terminal_slash_commands: ['odd-terminal'],
  });
}

function assistant(content) {
  const id = `msg_${randomUUID()}`;
  const message = { id, type: 'message', role: 'assistant', model, content, stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } };
  write({ type: 'assistant', message, parent_tool_use_id: null, ...base() });
  transcript({ type: 'assistant', message });
  return id;
}

function streamText(text) {
  const id = `msg_${randomUUID()}`;
  const event = (e) => write({ type: 'stream_event', event: e, parent_tool_use_id: null, ...base() });
  event({ type: 'message_start', message: { id } });
  for (const part of text.match(/.{1,4}/gs) ?? []) event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } });
  const message = { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } };
  write({ type: 'assistant', message, parent_tool_use_id: null, ...base() });
  transcript({ type: 'assistant', message });
}

function result(extra = {}) {
  write({
    type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: 'end_turn',
    total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }, modelUsage: {}, permission_denials: [], ...base(), ...extra,
  });
}

function interruptedResult() {
  result({ subtype: 'error_during_execution', is_error: true, errors: [], terminal_reason: 'aborted_streaming', stop_reason: null });
}

// One tool call: null when the turn was interrupted, else whether the call was allowed.
async function toolCall(tool, input) {
  const toolUseId = `toolu_${randomUUID()}`;
  assistant([{ type: 'tool_use', id: toolUseId, name: tool, input }]);
  const answer = await controlRequest({ subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: toolUseId, title: `Claude wants to use ${tool}` });
  log({ kind: 'permission-answer', tool, answer });
  if (interrupted || answer.interrupt) return null;
  const allowed = answer.behavior === 'allow';
  const text = allowed ? JSON.stringify(answer.updatedInput) : answer.message;
  const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: !allowed }];
  write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...base() });
  transcript({ type: 'user', message: { role: 'user', content } });
  return allowed;
}

async function toolTurn(tool, input, times = 1) {
  let allowed = false;
  for (let i = 0; i < times; i++) {
    allowed = await toolCall(tool, input);
    if (allowed === null) return interruptedResult();
  }
  streamText(allowed ? 'tool done' : 'tool refused');
  result();
}

async function mcpTurn(toolName, args, then, server = 'claude-os') {
  const call = async (message) => (await controlRequest({ subtype: 'mcp_message', server_name: server, message })).mcp_response;
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } });
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const called = toolName === 'LIST' ? null : await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: args } });
  if (then) await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: then.name, arguments: then.args } });
  streamText(`MCP_RESULT ${JSON.stringify({ tools: list.result.tools.map((t) => t.name), result: called?.result ?? null })}`);
  result();
}

// What the real CLI does at a tool boundary: messages sent with priority 'next' join the running turn.
function foldQueued() {
  while (queue[0]?.priority === 'next') {
    const { content } = queue.shift();
    streamText(`folded: ${contentText(content)}`);
  }
}

// The wait is a number of ms, or the path of a file the test creates to let the command finish.
async function bashTurn(wait, command) {
  const toolUseId = `toolu_${randomUUID()}`;
  assistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command, description: 'fake command' } }]);
  if (/^\d+$/.test(wait)) await sleep(Number(wait));
  else while (!existsSync(wait)) await sleep(20);
  const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: `${command}\nline 1\nline 2\nline 3\nline 4\nline 5`, is_error: false }];
  write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...base() });
  transcript({ type: 'user', message: { role: 'user', content } });
  await sleep(150); // the host hears the result and may answer before Claude goes on
  foldQueued();
  streamText('command done');
  result();
}

// A subagent the way the CLI runs one: a journal next to the session's, task events, its messages tagged with the parent call.
async function agentTurn(ms) {
  const toolUseId = `toolu_${randomUUID()}`;
  const agentId = `a${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const description = 'Fake subagent job';
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId }));
  const journal = (record) => appendFileSync(join(dir, `agent-${agentId}.jsonl`), JSON.stringify({ ...record, isSidechain: true, agentId, uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
  const task = { task_id: agentId, tool_use_id: toolUseId, description, subagent_type: 'general-purpose' };

  assistant([{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt: 'Do the fake job', subagent_type: 'general-purpose' } }]);
  write({ type: 'system', subtype: 'task_started', ...task, task_type: 'local_agent', ...base() });
  journal({ type: 'user', message: { role: 'user', content: 'Do the fake job' } });
  await sleep(ms);

  const innerId = `toolu_${randomUUID()}`;
  const call = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: innerId, name: 'Bash', input: { command: 'echo from-subagent' } }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
  write({ type: 'assistant', message: call, parent_tool_use_id: toolUseId, ...base() });
  journal({ type: 'assistant', message: call });
  write({ type: 'system', subtype: 'task_progress', ...task, usage: { total_tokens: 1200, tool_uses: 1, duration_ms: ms }, last_tool_name: 'Bash', ...base() });
  await sleep(ms);

  const inner = [{ type: 'tool_result', tool_use_id: innerId, content: 'from-subagent', is_error: false }];
  write({ type: 'user', message: { role: 'user', content: inner }, parent_tool_use_id: toolUseId, ...base() });
  journal({ type: 'user', message: { role: 'user', content: inner } });
  await sleep(ms);

  const words = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'SUBAGENT_REPORT done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  write({ type: 'assistant', message: words, parent_tool_use_id: toolUseId, ...base() });
  journal({ type: 'assistant', message: words });
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId, finished: true }));
  write({ type: 'system', subtype: 'task_notification', task_id: agentId, tool_use_id: toolUseId, status: 'completed', output_file: '', summary: 'done', usage: { total_tokens: 1500, tool_uses: 1, duration_ms: ms * 3 }, ...base() });
  const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: 'SUBAGENT_REPORT done', is_error: false }];
  write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...base() });
  transcript({ type: 'user', message: { role: 'user', content } });
  streamText('agent finished');
  result();
}

// A job of the hidden service session. FAKE_CLAUDE_SERVICE: do (call the tool), idle (end without it), ask (a tool that needs a prompt).
// FAKE_CLAUDE_SERVICE_GATE: a file the test creates to let the job go on.
async function serviceTurn(text) {
  if (text.startsWith('A task from the user') || text.startsWith("The user's answer")) return serviceTaskTurn(text);
  const id = /Its id is `([^`]+)`/.exec(text)?.[1];
  const version = /its version is `([^`]+)`/.exec(text)?.[1];
  const gate = process.env.FAKE_CLAUDE_SERVICE_GATE;
  while (gate && !existsSync(gate)) await sleep(20);
  const mode = process.env.FAKE_CLAUDE_SERVICE;
  if (mode === 'ask') return toolTurn('Bash', { command: 'ls' });
  if (mode !== 'do' || !id) return runDefault(text);
  const file = { folder: null, topic: 'Фейк', title: 'Разложено' };
  // As the template says: a text that is already a list stays.
  if (/<note>\n- \[/.test(text)) return mcpTurn('file_planner_note', { id, ...file });
  return mcpTurn('set_planner_note_text', { id, version, text: '- [ ] первый\n- [ ] второй' }, { name: 'file_planner_note', args: { id, ...file } });
}

// A request from the user. The word in it says what the test wants from the job.
async function serviceTaskTurn(text) {
  const gate = process.env.FAKE_CLAUDE_SERVICE_GATE;
  while (gate && !existsSync(gate)) await sleep(20);
  if (text.startsWith("The user's answer")) { streamText(`Сделано: ${text.split('\n')[1]}`); return result(); }
  if (text.includes('ASK')) {
    return mcpTurn('ask_owner', { questions: ['Какой цвет?', 'Какой размер?'] });
  }
  if (text.includes('WRITECONFIG')) return toolTurn('Write', { file_path: /Путь: (\S+)/.exec(text)[1], content: 'x' });
  if (text.includes('WRITEOUTSIDE')) return toolTurn('Write', { file_path: '/tmp/outside', content: 'x' });
  if (text.includes('BASH')) return toolTurn('Bash', { command: 'ls' });
  streamText('Ответ служебной сессии');
  return result();
}

// The first-run setup tab. FAKE_CLAUDE_SETUP: a profile as JSON (saved and finished the way the onboarding does it),
// or 'fail' (the first prompt breaks off with an error, anything after it is echoed).
function setupTurn(text) {
  const mode = process.env.FAKE_CLAUDE_SETUP;
  if (mode === 'fail' && text.includes('## What the server found')) return result({ subtype: 'error_during_execution', is_error: true, errors: ['Fake setup failure'] });
  if (!mode || mode === 'fail') return runDefault(text);
  return mcpTurn('save_profile', JSON.parse(mode), { name: 'complete_setup', args: {} }, 'claude-os-setup');
}

// What the account probe hears. FAKE_CLAUDE_ACCOUNT is a JSON file read at each start, so a test can log in between checks:
// { account?: initialize's account, usage?: the get_usage answer, error?: get_usage refused, as when logged out }.
function accountFixture() {
  const file = process.env.FAKE_CLAUDE_ACCOUNT;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function runDefault(text) {
  streamText(`echo: ${text}`);
  return result();
}

async function runTurn(text) {
  init();
  interrupted = false;
  const [word, ...rest] = text.split(' ');
  transcript({ type: 'user', message: { role: 'user', content: text } });
  if (cwd.endsWith('/service')) return serviceTurn(text);
  if (cwd.endsWith('/setup')) return setupTurn(text);

  switch (word) {
    case 'TOOL': { // TOOL <name> <json input>
      const [tool, ...json] = rest;
      return toolTurn(tool, JSON.parse(json.join(' ')));
    }
    case 'TOOLS': { // TOOLS <n> <name> <json input>: the same call n times in one turn
      const [times, tool, ...json] = rest;
      return toolTurn(tool, JSON.parse(json.join(' ')), Number(times));
    }
    case 'SLOW': // streams until interrupted
      while (!interrupted) {
        write({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_slow' } }, parent_tool_use_id: null, ...base() });
        write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tick ' } }, parent_tool_use_id: null, ...base() });
        await sleep(30);
      }
      return interruptedResult();
    case 'HOLD': // HOLD <ms>
      await sleep(Number(rest[0]));
      streamText(`held ${rest[0]}`);
      return result();
    case 'BASHRUN': // BASHRUN <ms or gate file> <command>
      return bashTurn(rest[0], rest.slice(1).join(' '));
    case 'AGENT': // AGENT <step ms>
      return agentTurn(Number(rest[0]));
    case 'MANY': // MANY <n>: a long conversation, one message after another
      for (let i = 0; i < Number(rest[0]); i++) assistant([{ type: 'text', text: `Сообщение ${i}\n\n${'строка текста сообщения '.repeat(10 + (i % 7) * 12)}` }]);
      return result();
    case 'STREAMLINES': { // STREAMLINES <n> <ms>: a reply growing line by line, as a long answer does
      const id = `msg_${randomUUID()}`;
      write({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null, ...base() });
      let text = '';
      for (let i = 0; i < Number(rest[0]) && !interrupted; i++) {
        const part = `поток ${i}\n\n`;
        text += part;
        write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }, parent_tool_use_id: null, ...base() });
        await sleep(Number(rest[1]));
      }
      if (interrupted) return interruptedResult();
      const message = { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } };
      write({ type: 'assistant', message, parent_tool_use_id: null, ...base() });
      transcript({ type: 'assistant', message });
      return result();
    }
    case 'CALL': { // CALL <json {name, input, result, isError}>: a tool call that is already over
      const c = JSON.parse(rest.join(' '));
      const toolUseId = `toolu_${randomUUID()}`;
      assistant([{ type: 'tool_use', id: toolUseId, name: c.name, input: c.input }]);
      const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: c.result ?? '', is_error: c.isError === true }];
      write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...base() });
      transcript({ type: 'user', message: { role: 'user', content } });
      streamText('call over');
      return result();
    }
    case 'SAY': // SAY <text>: the text as it is, the markdown of a real answer
      streamText(rest.join(' ').replaceAll('\\n', '\n'));
      return result();
    case 'CRASH':
      process.stderr.write('fake crash on stderr\n');
      process.exit(3);
      break;
    case 'RATE':
      write({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }, ...base() });
      streamText('rate limited');
      return result();
    case 'MCP': { // MCP <tool|LIST> <json args>
      const [tool, ...json] = rest;
      return mcpTurn(tool, json.length ? JSON.parse(json.join(' ')) : {});
    }
    case '/clear':
      sessionId = randomUUID();
      write({ type: 'conversation_reset', new_conversation_id: sessionId, trigger: 'clear', ...base() });
      return result({ total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    case '/compact':
      write({ type: 'system', subtype: 'compact_boundary', ...base(), compact_metadata: { trigger: 'manual', pre_tokens: 100 } });
      return result();
    default:
      return runDefault(text);
  }
}

function contentText(content) {
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) await runTurn(contentText(queue.shift().content));
  running = false;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    const { subtype } = msg.request;
    if (subtype === 'initialize') {
      log({ kind: 'initialize', request: msg.request });
      write({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: msg.request_id,
          response: {
            commands: [], agents: [], output_style: 'default', available_output_styles: ['default'],
            models: [{ value: 'fake-sonnet', displayName: 'Fake Sonnet', description: 'test' }, { value: 'fake-opus', displayName: 'Fake Opus', description: 'test' }],
            account: accountFixture().account ?? {},
          },
        },
      });
    } else {
      log({ kind: 'control', subtype, request: msg.request });
      if (subtype === 'interrupt') interrupted = true;
      if (subtype === 'set_permission_mode') {
        if (msg.request.mode === 'bypassPermissions' && !bypassAllowed) {
          write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Cannot set permission mode to bypassPermissions' } });
          return;
        }
        permissionMode = msg.request.mode;
        write({ type: 'system', subtype: 'status', status: null, permissionMode, ...base() });
      }
      if (subtype === 'get_usage') {
        const { usage, error } = accountFixture();
        write({ type: 'control_response', response: error ? { subtype: 'error', request_id: msg.request_id, error } : { subtype: 'success', request_id: msg.request_id, response: usage ?? {} } });
        return;
      }
      if (subtype === 'remote_control') {
        const response = process.env.FAKE_CLAUDE_RC_ERROR
          ? { subtype: 'error', request_id: msg.request_id, error: process.env.FAKE_CLAUDE_RC_ERROR }
          : { subtype: 'success', request_id: msg.request_id, response: msg.request.enabled ? { session_url: `https://claude.ai/code/session_${sessionId}`, connect_url: 'https://claude.ai/code?environment=fake', environment_id: 'env_fake', bridge_session_id: sessionId } : {} };
        write({ type: 'control_response', response });
        return;
      }
      write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    }
  } else if (msg.type === 'control_response') {
    const entry = waiting.get(msg.response.request_id);
    if (!entry) return;
    waiting.delete(msg.response.request_id);
    if (msg.response.subtype === 'success') entry.resolve(msg.response.response);
    else entry.reject(new Error(msg.response.error));
  } else if (msg.type === 'user') {
    log({ kind: 'user', content: msg.message.content, priority: msg.priority ?? null });
    queue.push({ content: msg.message.content, priority: msg.priority });
    void drain();
  }
});
const linger = Number(process.env.FAKE_CLAUDE_LINGER_MS ?? 0);
rl.on('close', () => {
  if (linger > 0) setTimeout(() => process.exit(0), linger);
  else process.exit(0);
});
if (linger > 0) process.on('SIGTERM', () => setTimeout(() => process.exit(0), linger)); // slow to go on SIGTERM too
