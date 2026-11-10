// Each session kind's MCP tools against its allowedTools, as manager.ts hands them to the SDK, and the tool names the prompts mention.
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
import { PROGRESS_RULE, UI_TOOL_RULE } from './rootMcp.ts';
import type { TabRow } from './session.ts';

const REPO = join(import.meta.dirname, '../..');

type Kind = 'root' | 'work' | 'service' | 'serviceTask' | 'setup';

// Registered but not in allowedTools: each one asks the user before it runs.
const PROMPTED_TOOLS: Record<Kind, string[]> = {
  root: [
    'remove_kanban_sprint', // drops a sprint from every card: the user confirms
  ],
  work: [
    'remove_planner_item', // a removed item cannot be undone; marking it (check_planner_item) can
    'kit_apply', // writes the project kit: the permission card shows the plan, and only its Apply button approves it
  ],
  service: [],
  serviceTask: [], // nobody answers a prompt there: a tool that asks is not registered
  setup: [],
};

// Backticked snake_case words in the prompts that are not tools.
const NOT_TOOLS = ['tab_progress']; // the table the progress widget reads, root/CLAUDE.md

interface Session { allowed: string[]; registered: string[] }

const SETUP_TAB = 'tab-setup';
let kit: TestKit;
const sessions = {} as Record<Kind, Session>;

async function registeredTools(servers: Record<string, unknown>): Promise<string[]> {
  const names: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server as McpSdkServerConfigWithInstance).instance.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    names.push(...(await client.listTools()).tools.map((t) => `mcp__${name}__${t.name}`));
    await client.close();
  }
  return names;
}

before(async () => {
  kit = makeKit();
  kit.ctx.db = new DatabaseSync(':memory:');
  kit.ctx.settings = { profile: () => null, setup: () => ({ step: 'onboarding', completedAt: null, tabId: SETUP_TAB }) } as never;
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
    sessions[kind] = { allowed: (options.allowedTools ?? []).filter((t) => t.startsWith('mcp__')), registered: await registeredTools(options.mcpServers ?? {}) };
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

  it('kit_apply is never allowed', () => {
    for (const [kind, s] of Object.entries(sessions)) assert.deepEqual(s.allowed.filter((t) => short(t) === 'kit_apply'), [], kind);
  });

  it('prompts name only existing tools', () => {
    const full = new Set(Object.values(sessions).flatMap((s) => s.registered));
    const names = new Set([...full].map(short));
    const md = (dir: string) => (existsSync(join(REPO, dir)) ? readdirSync(join(REPO, dir)).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)) : []);
    const files = ['root/CLAUDE.md', 'root/NOTE_RULES.md', 'service/CLAUDE.md', 'setup/SETUP.md', ...md('root/reference'), ...md('root/microtasks')];
    const unknown: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), 'utf8');
      for (const [m] of text.matchAll(/mcp__[\w-]+?__\w+/g)) if (!full.has(m)) unknown.push(`${file}: ${m}`);
      for (const [, m] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)[`(]/g)) if (!names.has(m) && !NOT_TOOLS.includes(m)) unknown.push(`${file}: ${m}`);
    }
    for (const [rule, text] of Object.entries({ UI_TOOL_RULE, PROGRESS_RULE, DOCUMENT_RULE })) {
      for (const [m] of text.matchAll(/mcp__[\w-]+?__\w+/g)) if (!full.has(m)) unknown.push(`${rule}: ${m}`);
      for (const [m] of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!names.has(m)) unknown.push(`${rule}: ${m}`);
    }
    assert.deepEqual(unknown, []);
  });
});
