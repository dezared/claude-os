// The `/` menu. A running session answers for itself; before the first message a short-lived CLI does, no tokens spent.
import type { CommandInfo, MessageKey, Skill, TerminalRun } from '../../shared/contract.ts';
import { BTW_COMMAND, OFF_CHAT } from '../../shared/commands.ts';
import type { Ctx } from '../context.ts';
import { probeCli } from '../chat/probe.ts';
import { runInPty } from '../chat/terminal.ts';
import { FOCUS_COMMAND, REMOTE_CONTROL_COMMANDS, slashCommands, VIEW_COMMAND } from '../chat/translate.ts';
import { safely } from '../memory/util.ts';

const CACHE_MS = 5 * 60_000;
const DESCRIPTION_CHARS = 200;

interface RawCommand { name: string; description?: string; argumentHint?: string; builtin?: boolean; }

export function toCommandInfo(listed: RawCommand[], skills: Pick<Skill, 'name' | 'scope' | 'source'>[], terminal: string[]): CommandInfo[] {
  // The CLI does not list it for SDK sessions, Claude OS answers it through the control request.
  const raw = listed.some((c) => REMOTE_CONTROL_COMMANDS.has(c.name.replace(/^\//, ''))) ? [...listed] : [...listed, { name: 'rc', description: 'Remote Control: continue this session from claude.ai/code or the phone', builtin: true }];
  const has = (name: string) => raw.some((c) => c.name.replace(/^\//, '') === name);
  if (!has(FOCUS_COMMAND)) raw.push({ name: FOCUS_COMMAND, description: 'Toggle focus view: just your prompt, summary, and response', argumentHint: '[on|off]', builtin: true });
  if (!has(VIEW_COMMAND)) raw.push({ name: VIEW_COMMAND, description: 'Chat width: default, large, or full', argumentHint: '[default|large|full]', builtin: true });
  // Claude OS answers it on the side, whatever the CLI says about its own version.
  raw.push({ name: BTW_COMMAND, description: 'Ask a quick side question without interrupting the main conversation', argumentHint: '<question>', builtin: true });
  // The CLI leaves these out for SDK sessions. They stay in the menu, entering one explains where it works.
  const offChat = Object.entries(OFF_CHAT).filter(([name, c]) => c.menu !== undefined && !has(name));
  raw.push(...offChat.map(([name, c]) => ({ name, description: c.menu, builtin: true })));
  const needsTerminal = new Map(slashCommands(raw.map((c) => c.name), [...terminal.filter((n) => n !== BTW_COMMAND), ...offChat.map(([name]) => name)]).map((c) => [c.name, c.needsTerminal]));
  const seen = new Map<string, CommandInfo>();
  for (const c of raw) {
    const name = c.name.replace(/^\//, '');
    const suffix = /\s*\(([^()]*)\)\s*$/.exec(c.description ?? '');
    const scope = skills.find((s) => s.name === name || `${s.source}:${s.name}` === name)?.scope;
    const source: CommandInfo['source'] = c.builtin ? 'builtin'
      : suffix?.[1] === 'project' || scope === 'project' ? 'project'
      : name.includes(':') || scope === 'plugin' ? 'plugin'
      : 'skill';
    const clean = suffix ? (c.description ?? '').slice(0, suffix.index) : c.description ?? '';
    const description = clean.length > DESCRIPTION_CHARS ? `${clean.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : clean;
    const item: CommandInfo = { name, description: description || null, argumentHint: c.argumentHint || null, source, needsTerminal: needsTerminal.get(c.name) === true };
    // Rows can share a name: the marked one is what /name runs.
    if (!seen.has(name) || c.builtin) seen.set(name, item);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createCommands(ctx: Ctx, skills: () => Skill[]) {
  const cache = new Map<string, { at: number; list: Promise<RawCommand[]> }>();

  function fromProbe(cwd: string): Promise<RawCommand[]> {
    const hit = cache.get(cwd);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const list = probeCli(ctx, cwd, true, (q) => q.supportedCommands());
    list.catch(() => cache.delete(cwd));
    cache.set(cwd, { at: Date.now(), list });
    return list;
  }

  let doctorRun: Promise<{ output: string; error: string | null; runs: TerminalRun[] } & MessageKey> | null = null;

  return {
    invalidate: () => cache.clear(),
    // `claude doctor` reads local data only: no session, no tokens.
    doctor() {
      doctorRun ??= new Promise((resolve) => {
        ctx.setBusy('pty:doctor', true);
        runInPty(ctx, ctx.paths.root, 'doctor', (screen, done, error, runs, message) => {
          if (!done) return;
          doctorRun = null;
          ctx.setBusy('pty:doctor', false);
          resolve({ output: screen, error, runs, ...message });
        }, true);
      });
      return doctorRun;
    },
    async forTab(id: string): Promise<CommandInfo[]> {
      const chat = ctx.chat;
      if (!chat) return [];
      const { cwd } = chat.tabInfo(id);
      const all = safely(skills, []);
      const terminal = chat.terminalCommands();
      try {
        const raw = (await chat.liveCommands(id).catch(() => null)) ?? (await fromProbe(cwd));
        return toCommandInfo(raw, all, terminal);
      } catch (err) {
        ctx.app.log.warn(err);
        // The CLI did not answer: skills on disk are still real commands.
        return toCommandInfo(all.filter((s) => !s.disabled).map((s) => ({ name: s.scope === 'plugin' && s.source ? `${s.source}:${s.name}` : s.name, description: s.description ?? '' })), all, terminal);
      }
    },
  };
}
