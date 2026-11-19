// What the server part of a shipped Claude OS plugin gets and gives back. The plugin imports only these types: everything
// it runs with comes in through the host, so it needs no packages of its own and no paths into the core.
import type { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { SessionInfo, Tab } from '../../shared/contract.ts';
import type { PluginServerStatus } from '../../shared/osPluginServer.ts';

/** The session kinds a plugin can give tools to: a work tab, the root tab, a task of the service session. */
export const PLUGIN_SCOPES = ['work', 'root', 'serviceTask'] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

/** Who asks for the tools: the tab they are made for, its title as the agent's name, its project. */
export interface PluginWho { scope: PluginScope; tab: string | null; agent?: string; project: string | null }

export interface PluginRequest { params: Record<string, string>; query: Record<string, string>; headers: Record<string, string | string[] | undefined>; body: unknown }
// A path may end in /*: the rest of the URL is params['*']. A handler that returns a Response has it sent as it is: status, headers, a streamed body.
export interface PluginRoute { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; handler: (req: PluginRequest) => unknown }

// As createSdkMcpServer takes them: each tool keeps its own input type.
export type PluginTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];

export interface PluginHost {
  id: string;
  paths: { vault: string; app: string; data: string; backups: string }; // app: Claude OS's data/; data: the plugin's own folder in it
  tool: typeof tool;
  z: typeof z;
  parseFrontmatter(text: string): { data: Record<string, string>; body: string };
  projects(): { key: string; name: string }[];
  osProject(): string | null; // the Claude OS project's key, when it is known
  tabs(): Tab[];
  sessions(ids: string[]): (SessionInfo & { costUsd: number | null })[];
  language(): string; // the user's interface language, for tool descriptions
  invalidate(): void; // the interface refetches what it reads under the osPluginData topic
  statusChanged(): void; // the plugins screen reads status() again
  audit(action: string, target: string, diff?: string | null): void;
}

export interface PluginServer {
  routes?: PluginRoute[]; // served under /api/plugins/<id>
  tools?: (who: PluginWho) => PluginTool[]; // inside the claude-os MCP server, under their own names
  allowed?: Partial<Record<PluginScope, string[]>>; // of those, the ones that run without a prompt
  rules?: Partial<Record<PluginScope, string>>; // a line for the system prompt
  dirs?: string[]; // folders every session may read
  views?: string[]; // names ui_action may open: the screen of the plugin's interface with the same id
  sessionStarted?: (tabId: string, sessionId: string) => void; // a tab got its session id
  status?: () => PluginServerStatus; // a process the part keeps running, shown on the plugin's row
  dispose?: () => void;
}
