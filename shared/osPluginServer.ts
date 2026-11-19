// The state of a process a shipped plugin's server part keeps running, as its row on the plugins screen shows it.
export const PLUGIN_SERVER_STATES = ['starting', 'running', 'failed', 'stopped'] as const;
export type PluginServerState = (typeof PLUGIN_SERVER_STATES)[number];

export interface PluginServerStatus {
  state: PluginServerState;
  detail: string | null; // failed: why, in the process's own words
  external: boolean; // running: another program already served the address, so it is used instead of starting a second one
}
