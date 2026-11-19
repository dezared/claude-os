// agentation in the Claude OS server: while the plugin is enabled its HTTP server runs as a supervised child of this one,
// and the sessions that handle notes get its tools inside the claude-os MCP server.
import { join } from 'node:path';
import type { PluginHost, PluginServer, PluginWho } from '../../../server/tools/pluginServerApi.ts';
import { proxyRoutes } from './proxy.ts';
import { Supervisor } from './supervisor.ts';
import { TOOL_NAMES, agentationTools } from './tools.ts';

const PROBE_MS = 800;
const DAEMON = join(import.meta.dirname, 'daemon.ts');
const ASKS_NOTHING = TOOL_NAMES.filter((t) => t !== 'agentation_dismiss'); // a dismissal is the user's call

// The daemon's port, which the toolbar reaches through the proxy; another port only for tests, which must never reach the user's server.
export const agentationPort = (env = process.env) => Number(env.CLAUDE_OS_AGENTATION_PORT) || 4747;

// Where Claude OS pages live: its own port (the main window and the popouts) and the dev server, as the core's origin check reads them.
export const claudeOsOrigins = (env = process.env) => {
  const port = Number(env.CLAUDE_OS_PORT ?? 47821);
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(env.CLAUDE_OS_DEV_ORIGIN ? [env.CLAUDE_OS_DEV_ORIGIN] : [])];
};

/** Whether the address answers as an agentation server: its /health says ok and names its mode. */
export const probe = (base: string) => async () => {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_MS) });
    const body = res.ok ? ((await res.json()) as { status?: unknown; mode?: unknown }) : null;
    return body?.status === 'ok' && typeof body.mode === 'string';
  } catch {
    return false;
  }
};

export function activate(host: PluginHost): PluginServer {
  const port = agentationPort();
  const base = `http://127.0.0.1:${port}`;
  // The package from the project's own dependencies, run by this Node: nothing is downloaded at run time.
  const supervisor = new Supervisor({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', DAEMON, '--port', String(port)], probe: probe(base), onChange: () => host.statusChanged() });
  supervisor.start();
  // Notes are about the Claude OS interface: the root tab and the Claude OS project's work tabs handle them.
  const handles = (who: PluginWho) => who.scope === 'root' || (who.scope === 'work' && !!who.project && who.project === host.osProject());
  return {
    routes: proxyRoutes(base),
    tools: (who) => (handles(who) ? agentationTools(host, base, supervisor.status, claudeOsOrigins()) : []),
    allowed: { work: ASKS_NOTHING, root: ASKS_NOTHING },
    status: supervisor.status,
    dispose: () => void supervisor.stop(),
  };
}
