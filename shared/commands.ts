// Commands the chat cannot run. They stay in the `/` menu, and entering one opens a dialog instead of an error from the CLI.
// `why` is what was checked against Claude Code 2.1.318; null means it was not, and the dialog says only "not available in this mode":
//   panel: in a stream-json session the CLI answers "/name isn't available in this environment", the screen exists only in its terminal UI.
//   bound: the CLI reports it in terminal_slash_commands, tied to the local terminal.
//   model: it starts a model turn. The free check is `claude doctor`, Settings runs that one.
export interface OffChatCommand {
  why: 'panel' | 'bound' | 'model' | null;
  /** The CLI's own description. The menu gets a row from it when the CLI does not list the command for SDK sessions. */
  menu?: string;
  /** A screen of Claude OS with the same function. */
  link?: 'settings' | 'doctor' | 'sessions' | 'memory' | 'hooks' | 'plugins' | 'skills' | 'account' | 'theme';
  /** Claude OS can do it right here, or opens the control of the work tab that does it. */
  run?: 'plan' | 'close' | 'copy' | 'export' | 'git' | 'ide' | 'running' | 'mode' | 'branch';
  /** What Claude OS has in place of it, in one sentence of the dialog. */
  control?: 'git' | 'ide' | 'running' | 'mode' | 'account' | 'theme' | 'here';
  /** With arguments it is a normal message to Claude. */
  bareOnly?: boolean;
}

export const OFF_CHAT: Record<string, OffChatCommand> = {
  config: { why: 'panel', link: 'settings' },
  doctor: { why: 'model', link: 'doctor', bareOnly: true },
  'output-style': { why: null },
  color: { why: 'bound' },
  'reload-plugins': { why: 'bound', link: 'plugins' },
  statusline: { why: 'bound' },
  exit: { why: 'panel', menu: '', run: 'close' },
  plan: { why: 'panel', menu: 'Enable plan mode or view the current session plan', run: 'plan' },
  resume: { why: 'panel', menu: 'Resume a previous conversation', link: 'sessions' },
  memory: { why: 'panel', menu: 'Edit CLAUDE.md files and memory settings', link: 'memory' },
  hooks: { why: 'panel', menu: 'View hook configurations for tool events', link: 'hooks' },
  plugin: { why: 'panel', menu: 'Manage Claude Code plugins', link: 'plugins' },
  skills: { why: 'panel', menu: 'List available skills', link: 'skills' },
  diff: { why: 'panel', menu: 'View uncommitted changes and per-turn diffs', run: 'git', control: 'git' },
  ide: { why: 'panel', menu: 'Manage IDE integrations and show status', run: 'ide', control: 'ide' },
  tasks: { why: 'panel', menu: 'View and manage everything running in the background', run: 'running', control: 'running' },
  permissions: { why: 'panel', menu: 'Manage allow and deny tool permission rules', run: 'mode', control: 'mode' },
  login: { why: 'panel', menu: 'Sign in with your Anthropic account', link: 'account', control: 'account' },
  logout: { why: null, menu: 'Sign out from your Anthropic account', link: 'account', control: 'account' },
  theme: { why: 'panel', menu: 'Change the theme', link: 'theme', control: 'theme' },
  export: { why: 'panel', menu: 'Export the current conversation to a file or clipboard', run: 'export', control: 'here' },
  copy: { why: 'panel', menu: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", run: 'copy', control: 'here' },
  mobile: { why: 'panel', menu: 'Show QR code to download the Claude mobile app' },
  feedback: { why: 'panel', menu: 'Send feedback to Anthropic or report a bug' },
  powerup: { why: 'panel', menu: 'Discover Claude Code features through quick interactive lessons' },
  'terminal-setup': { why: 'panel', menu: '' },
  tui: { why: 'panel', menu: 'Set the terminal UI renderer (default | fullscreen)' },
  'add-dir': { why: 'panel', menu: 'Add a new working directory' },
  cd: { why: 'panel', menu: 'Move this session to a new working directory' },
  branch: { why: 'panel', menu: 'Create a branch of the current conversation at this point', run: 'branch', control: 'here' },
};

/** Answered by Claude OS itself, on the side, see server/chat/btw.ts. Not an off-chat command any more. */
export const BTW_COMMAND = 'btw';
