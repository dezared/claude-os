// The agentation tools inside the claude-os MCP server, under agentation-mcp's own names, so the skill keeps working.
// Each call asks the daemon over HTTP when it runs: a session that started before the daemon answered has working tools too.
import type { PluginHost, PluginTool } from '../../../server/tools/pluginServerApi.ts';
import type { PluginServerStatus } from '../../../shared/osPluginServer.ts';

export const TOOL_NAMES = ['agentation_get_all_pending', 'agentation_get_pending', 'agentation_acknowledge', 'agentation_resolve', 'agentation_reply', 'agentation_dismiss'] as const;

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

interface Annotation { id: string; kind?: string; comment: string; element: string; elementPath: string; url?: string; intent?: string; severity?: string; timestamp?: number; nearbyText?: string; reactComponents?: string }
interface Pending { count: number; annotations: Annotation[] }

// What agentation-mcp's own tool returns of a note: the fields that tell the element and the fix.
const brief = (a: Annotation) => ({ id: a.id, kind: a.kind ?? 'feedback', comment: a.comment, element: a.element, elementPath: a.elementPath, url: a.url, intent: a.intent, severity: a.severity, timestamp: a.timestamp, nearbyText: a.nearbyText, reactComponents: a.reactComponents });

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** `origins`: the Claude OS pages; notes from any other site on the same daemon are another project's, not this work. */
export function agentationTools(host: PluginHost, base: string, status: () => PluginServerStatus, origins: string[]): PluginTool[] {
  const { tool, z } = host;
  async function call(method: string, path: string, body?: object) {
    const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) throw new Error(`not found: ${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<unknown>;
  }
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      return ok(await work());
    } catch (err) {
      const s = status();
      const state = `${s.state}${s.detail ? `: ${s.detail}` : ''}`;
      return fail(`${(err as Error).message}. The agentation server at ${base} is ${state}; notes stay in the browser until it answers.`);
    }
  };
  const pending = async (path: string) => {
    const ours = ((await call('GET', path)) as Pending).annotations.filter((a) => origins.includes(originOf(a.url) ?? ''));
    return { count: ours.length, annotations: ours.map(brief) };
  };
  const note = z.string().describe('The annotation id');
  const thread = (id: string, content: string) => call('POST', `/annotations/${encodeURIComponent(id)}/thread`, { role: 'agent', content });
  const read = { annotations: { readOnlyHint: true } };
  return [
    tool('agentation_get_all_pending', 'Pending agentation notes on the Claude OS interface across all its pages and windows, notes on other sites left out: comment, element, its path and the text around it.', {}, async () => attempt(() => pending('/pending')), read),
    tool('agentation_get_pending', 'Pending agentation notes of one session (one page), only those on the Claude OS interface.', { sessionId: z.string().describe('The agentation session id') }, async ({ sessionId }) => attempt(() => pending(`/sessions/${encodeURIComponent(sessionId)}/pending`)), read),
    tool('agentation_acknowledge', 'Mark a note as seen: the user sees it is being worked on.', { annotationId: note }, async ({ annotationId }) => attempt(async () => {
      await call('PATCH', `/annotations/${encodeURIComponent(annotationId)}`, { status: 'acknowledged' });
      return { acknowledged: true, annotationId };
    })),
    tool('agentation_resolve', 'Mark a note as done, with a short summary of the fix.', { annotationId: note, summary: z.string().optional().describe('What was done') }, async ({ annotationId, summary }) => attempt(async () => {
      await call('PATCH', `/annotations/${encodeURIComponent(annotationId)}`, { status: 'resolved', resolvedBy: 'agent' });
      if (summary) await thread(annotationId, `Resolved: ${summary}`);
      return { resolved: true, annotationId, summary };
    })),
    tool('agentation_reply', 'Reply in a note\'s thread: a question or an update; the note stays open.', { annotationId: note, message: z.string() }, async ({ annotationId, message }) => attempt(async () => {
      await thread(annotationId, message);
      return { replied: true, annotationId, message };
    })),
    tool('agentation_dismiss', 'Dismiss a note with the reason, only when the user asks for it.', { annotationId: note, reason: z.string() }, async ({ annotationId, reason }) => attempt(async () => {
      await call('PATCH', `/annotations/${encodeURIComponent(annotationId)}`, { status: 'dismissed', resolvedBy: 'agent' });
      await thread(annotationId, `Dismissed: ${reason}`);
      return { dismissed: true, annotationId, reason };
    })),
  ];
}
