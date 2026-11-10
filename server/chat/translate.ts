import type { ChatBlock, SlashCommand, TokenCounts } from '../../shared/contract.ts';

// The CLI reports commands bound to the local terminal in terminal_slash_commands. These are the ones it
// advertises to SDK sessions (2.1.318) without that tag although they are full-screen dialogs in the terminal.
// /doctor is a model turn in 2.1.318: not for an invisible terminal. The Settings button runs the free `claude doctor`.
const NEEDS_TERMINAL = new Set(['agents', 'config', 'doctor', 'mcp', 'output-style', 'usage']);

// Their first screen is the whole answer, so a background pseudo-terminal can show it without any keys pressed. They
// run no model turn. Dialogs where the point is to change something (/config, /output-style, /login, /model...) stay terminal-only.
export const BACKGROUND_COMMANDS = new Set(['usage', 'status', 'stats', 'help', 'mcp', 'agents']);
export const REMOTE_CONTROL_COMMANDS = new Set(['rc', 'remote-control']); // the CLI's control request, see TabSession.toggleRemoteControl
export const CLEAR_COMMANDS = new Set(['clear', 'reset', 'new']); // /reset and /new are the CLI's aliases of /clear
export const FOCUS_COMMAND = 'focus'; // the CLI's own /focus switches its terminal view; here the same words switch the chat's, in the browser
export const VIEW_COMMAND = 'view'; // the width of the chat column, answered in the browser like /focus

export function slashCommands(all: string[], terminal: string[] = []): SlashCommand[] {
  const bound = new Set(terminal);
  const local = (name: string) => BACKGROUND_COMMANDS.has(name) || REMOTE_CONTROL_COMMANDS.has(name) || name === FOCUS_COMMAND || name === VIEW_COMMAND;
  return all.map((name) => ({ name, needsTerminal: (bound.has(name) || NEEDS_TERMINAL.has(name)) && !local(name) }));
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : `[${b.type ?? 'unknown'}]`))
    .join('\n');
}

export function assistantBlocks(content: unknown, subagent: string | null): ChatBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  for (const b of content as Record<string, unknown>[]) {
    if (b.type === 'text') blocks.push({ type: 'text', text: String(b.text ?? '') });
    else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: String(b.thinking ?? '') });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input, subagent });
  }
  return blocks;
}

export function tokenCounts(usage: Record<string, unknown> | null | undefined): TokenCounts {
  const n = (key: string) => (typeof usage?.[key] === 'number' ? (usage[key] as number) : 0);
  return {
    input: n('input_tokens'),
    output: n('output_tokens'),
    cacheWrite: n('cache_creation_input_tokens'),
    cacheRead: n('cache_read_input_tokens'),
  };
}
