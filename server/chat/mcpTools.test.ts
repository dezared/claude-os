// Each session kind's MCP tools against its allowedTools, as manager.ts hands them to the SDK, and the tool names the prompts mention.
// The shipped Kanban+ plugin is enabled, as it is by default: its tools and prompts are checked with the core's.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { DOCUMENT_RULE } from '../tools/documents.ts';
import { MICROTASK_TOOLS } from '../tools/microtasks.ts';
import { Chat } from './manager.ts';
import { createPluginServers } from '../tools/osPluginServers.ts';
import { KANBAN_RULE } from '../../plugins/kanban-plus/server/index.ts';
import { PROGRESS_RULE, UI_TOOL_RULE } from './rootMcp.ts';
import { sessionAppend, type TabRow } from './session.ts';

const REPO = join(import.meta.dirname, '../..');

type Kind = 'root' | 'work' | 'service' | 'serviceTask' | 'setup';

// Registered but not in allowedTools: each one asks the user before it runs.
const PROMPTED_TOOLS: Record<Kind, string[]> = {
  root: [
    'create_project', // makes a folder anywhere the user can write: the card shows the path
    'write_secret', // as in a work tab: /secret works on Home too
    'delete_secret',
  ],
  work: [
    'remove_planner_item', // a removed item cannot be undone; marking it (check_planner_item) can
    'add_kanban_card', // the board is the user's: a card appears only after a yes
    'add_kanban_board', // and so are its boards
    'update_kanban_board',
    'kit_apply', // writes the project kit: the permission card shows the plan, and only its Apply button approves it
    'write_secret', // writes a value the user hid into a project file: the card shows where, never the value
    'delete_secret', // a forgotten secret cannot be brought back
    'open_session', // starts a tab that spends tokens: the card names the project and the request
  ],
  service: [],
  serviceTask: [], // nobody answers a prompt there: a tool that asks is not registered
  setup: [],
};

// Backticked snake_case words in the prompts that are not tools.
const NOT_TOOLS = ['tab_progress']; // the table the progress widget reads, root/CLAUDE.md

interface Session { allowed: string[]; registered: string[]; loaded: string[] }

const SETUP_TAB = 'tab-setup';
let kit: TestKit;
const sessions = {} as Record<Kind, Session>;

// Every registered tool, and those the CLI puts in the prompt at once instead of deferring behind tool search.
async function registeredTools(servers: Record<string, unknown>): Promise<{ names: string[]; loaded: string[] }> {
  const names: string[] = [];
  const loaded: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server as McpSdkServerConfigWithInstance).instance.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    for (const t of (await client.listTools()).tools) {
      names.push(`mcp__${name}__${t.name}`);
      if (t._meta?.['anthropic/alwaysLoad'] === true) loaded.push(`mcp__${name}__${t.name}`);
    }
    await client.close();
  }
  return { names, loaded };
}

before(async () => {
  kit = makeKit();
  kit.ctx.db = new DatabaseSync(':memory:');
  kit.ctx.settings = { profile: () => null, setup: () => ({ step: 'onboarding', completedAt: null, tabId: SETUP_TAB }) } as never;
  kit.ctx.pluginServers = createPluginServers(kit.ctx, () => [{ id: 'kanban-plus', file: join(REPO, 'plugins/kanban-plus/server/index.ts') }]);
  const chat = new Chat(kit.ctx);
  const row = (id: string, kind: TabRow['kind']): TabRow => ({ id, kind, project: null, cwd: kit.paths.root, sessionId: null, title: id, order: 1, model: null, effort: null, worktree: false, turnOpen: false, interruptedAt: null, permissionMode: null });
  const running = (task: boolean) => {
    // Every template's extra tools at once: each must be registered where it is allowed.
    (chat as unknown as { serviceRunning: unknown }).serviceRunning = { task, tools: [...new Set(Object.values(MICROTASK_TOOLS).flat())] };
  };
  const rows: [Kind, TabRow, (() => void)?][] = [
    ['root', row('tab-root', 'root')],
    ['work', row('tab-work', 'work')],
    ['service', row('tab-service', 'service'), () => running(false)],
    ['serviceTask', row('tab-service', 'service'), () => running(true)],
    ['setup', row(SETUP_TAB, 'work')],
  ];
  for (const [kind, r, prepare] of rows) {
    prepare?.();
    const options = chat.extraOptions(r);
    const { names, loaded } = await registeredTools(options.mcpServers ?? {});
    sessions[kind] = { allowed: (options.allowedTools ?? []).filter((t) => t.startsWith('mcp__')), registered: names, loaded };
  }
});

after(() => kit.close());

const short = (tool: string) => tool.replace(/^mcp__[\w-]+?__/, '');

describe('mcp tools and allowedTools per session kind', () => {
  it('allowed tools are registered', () => {
    for (const [kind, s] of Object.entries(sessions)) {
      assert.ok(s.allowed.length > 0, kind);
      assert.deepEqual(s.allowed.filter((t) => !s.registered.includes(t)), [], kind);
    }
  });

  it('registered but not allowed is the prompted list', () => {
    for (const [kind, s] of Object.entries(sessions)) {
      assert.deepEqual(s.registered.filter((t) => !s.allowed.includes(t)).map(short).sort(), [...PROMPTED_TOOLS[kind as Kind]].sort(), kind);
    }
  });

  // A deferred memory_search cost every session a ToolSearch round trip before its first search.
  it('memory_search loads with the session wherever it is registered', () => {
    const kinds = Object.entries(sessions).filter(([, s]) => s.registered.some((t) => short(t) === 'memory_search'));
    assert.ok(kinds.length >= 3, kinds.map(([k]) => k).join());
    for (const [kind, s] of kinds) assert.ok(s.loaded.map(short).includes('memory_search'), kind);
  });

  it('kit_apply is never allowed', () => {
    for (const [kind, s] of Object.entries(sessions)) assert.deepEqual(s.allowed.filter((t) => short(t) === 'kit_apply'), [], kind);
  });

  it('prompts name only existing tools', () => {
    const full = new Set(Object.values(sessions).flatMap((s) => s.registered));
    const names = new Set([...full].map(short));
    const md = (dir: string) => (existsSync(join(REPO, dir)) ? readdirSync(join(REPO, dir)).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)) : []);
    const files = ['root/CLAUDE.md', 'root/NOTE_RULES.md', 'service/CLAUDE.md', 'setup/SETUP.md', 'plugins/kanban-plus/reference.md', ...md('root/reference'), ...md('root/microtasks')];
    const unknown: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), 'utf8');
      for (const [m] of text.matchAll(/mcp__[\w-]+?__\w+/g)) if (!full.has(m)) unknown.push(`${file}: ${m}`);
      for (const [, m] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)[`(]/g)) if (!names.has(m) && !NOT_TOOLS.includes(m)) unknown.push(`${file}: ${m}`);
    }
    const pluginRules = Object.fromEntries((['work', 'root'] as const).map((k) => [`kanban-plus ${k}`, kit.ctx.pluginServers!.rules(k).join('\n')]));
    for (const [rule, text] of Object.entries({ UI_TOOL_RULE, PROGRESS_RULE, DOCUMENT_RULE, ...pluginRules })) {
      for (const [m] of text.matchAll(/mcp__[\w-]+?__\w+/g)) if (!full.has(m)) unknown.push(`${rule}: ${m}`);
      for (const [m] of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!names.has(m)) unknown.push(`${rule}: ${m}`);
    }
    assert.deepEqual(unknown, []);
  });

  it('a work tab may update kanban cards, asks to add one and is told when to ask', () => {
    for (const t of ['update_kanban_card', 'list_kanban_cards']) assert.ok(sessions.work.allowed.includes(`mcp__claude-os__${t}`), t);
    assert.ok(!sessions.work.allowed.includes('mcp__claude-os__add_kanban_card'));
    assert.match(KANBAN_RULE, /never add one unasked/);
    assert.deepEqual(kit.ctx.pluginServers!.rules('work'), [KANBAN_RULE]);
    assert.ok(sessionAppend({ profile: '', note: null, noteRules: '', document: null, plugins: [KANBAN_RULE] }).includes(KANBAN_RULE));
  });
});
