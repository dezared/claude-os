// Commands the CLI draws only as terminal screens (/usage...). They run in a real but invisible terminal, and what that
// terminal shows goes to the chat. Only commands without a model turn come here, see BACKGROUND_COMMANDS: no tokens.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { MessageKey, TerminalRun } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { findJournal } from '../journal/parse.ts';
import { ignoredSessions } from '../journal/live.ts';

const COLS = 90;
const ROWS = 40;
const TICK_MS = 150;
const SETTLE_MS = Number(process.env.CLAUDE_OS_PTY_SETTLE_MS ?? 4000); // data like /usage loads for a while behind a still screen
const MAX_MS = 30_000;
const REMOVE_AFTER_MS = 2000; // the killed CLI still writes on its way out
const FORGET_AFTER_MS = 30_000;

const MAX_STYLED_LINES = 500; // past that the text still comes, without its colours: a long scrollback is not worth reading cell by cell

type Show = (screen: string, done: boolean, error: string | null, runs: TerminalRun[], message?: MessageKey) => void; // message: the error's key

/** The colours of the buffer as runs over the lines of `lines`. `line` counts from the first line with text, as the trimmed screen does. */
function readRuns(term: HeadlessTerminal, lines: string[]): TerminalRun[] {
  const first = lines.findIndex((l) => l.trim());
  if (first < 0 || lines.length > MAX_STYLED_LINES) return [];
  const indent = lines[first].length - lines[first].trimStart().length; // the screen's trim takes it from the first line
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const runs: TerminalRun[] = [];
  for (let i = first; i < lines.length; i++) {
    const row = buf.getLine(i);
    if (!row) continue;
    const shift = i === first ? indent : 0;
    let open: TerminalRun | null = null;
    let at = 0;
    for (let x = 0; x < term.cols && at < lines[i].length; ) {
      row.getCell(x, cell);
      const size = (cell.getChars() || ' ').length;
      const run: TerminalRun = { line: i - first, from: at - shift, to: at + size - shift };
      if (cell.isFgRGB()) run.fg = `#${cell.getFgColor().toString(16).padStart(6, '0')}`;
      else if (cell.isFgPalette()) run.fg = cell.getFgColor();
      if (cell.isBgRGB()) run.bg = `#${cell.getBgColor().toString(16).padStart(6, '0')}`;
      else if (cell.isBgPalette()) run.bg = cell.getBgColor();
      if (cell.isBold()) run.bold = true;
      if (cell.isDim()) run.dim = true;
      if (cell.isInverse()) run.inverse = true;
      const prev: TerminalRun | null = open;
      const same = prev && prev.fg === run.fg && prev.bg === run.bg && prev.bold === run.bold && prev.dim === run.dim && prev.inverse === run.inverse;
      if (prev && same) prev.to = run.to;
      else if (run.fg !== undefined || run.bg !== undefined || run.bold || run.dim || run.inverse) {
        open = run;
        if (run.from >= 0) runs.push(run);
      } else open = null;
      at += size;
      x += cell.getWidth() || 1;
    }
  }
  return runs;
}

/** Starts the command, calls show on every change of the screen and once with done:true. Returns the way to stop it early. */
export function runInPty(ctx: Ctx, cwd: string, command: string, show: Show, subcommand = false): () => void {
  let stop: () => void = () => {};
  let stopped = false;
  void (async () => {
    // The packages are native and platform-bound: without them only this route is lost, not the server.
    const { spawn } = await import('@lydell/node-pty');
    const { Terminal } = (await import('@xterm/headless')).default; // CommonJS, no named exports for import()
    if (stopped) return show('', true, null, []);
    const sessionId = randomUUID();
    ignoredSessions.add(sessionId);
    const bin = ctx.paths.claudeBin;
    // `claude doctor` and the like start no session and refuse the session's flags.
    const argv = subcommand ? [command] : [command, '--session-id', sessionId, '--settings', '{"disableAllHooks":true}'];
    const { CLAUDECODE: _nested, ...env } = process.env;
    const pty = /\.m?js$/.test(bin)
      ? spawn(process.execPath, [bin, ...argv], { cols: COLS, rows: ROWS, cwd, env: { ...env, TERM: 'xterm-256color' } })
      : spawn(bin, argv, { cols: COLS, rows: ROWS, cwd, env: { ...env, TERM: 'xterm-256color' } });
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
    pty.onData((d) => term.write(d));
    term.onData((d) => pty.write(d)); // the UI asks the terminal about itself and waits for the answer

    const screenLines = () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true).trimEnd() ?? '');
      return lines;
    };
    const started = Date.now();
    let last = '';
    let changed = started;
    let finished = false;
    const finish = (error: string | null, message?: MessageKey) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      const lines = screenLines();
      const final = lines.join('\n').trim();
      const runs = readRuns(term, lines);
      try { pty.kill(); } catch { /* already gone */ }
      term.dispose();
      if (error || final) show(final, true, error, runs, message);
      else show(final, true, 'The command showed nothing', runs, { key: 'terminalEmpty' });
      // A throwaway session must not appear in the list of sessions.
      setTimeout(() => {
        const journal = safeJournal(sessionId, cwd, ctx);
        if (journal) rmSync(journal, { force: true });
      }, REMOVE_AFTER_MS).unref();
      setTimeout(() => ignoredSessions.delete(sessionId), FORGET_AFTER_MS).unref();
    };
    const timer = setInterval(() => {
      const lines = screenLines();
      const now = lines.join('\n').trim();
      if (now !== last) {
        last = now;
        changed = Date.now();
        show(now, false, null, readRuns(term, lines));
      }
      if (last && Date.now() - changed >= SETTLE_MS) finish(null);
      else if (Date.now() - started >= MAX_MS) finish(last ? null : 'The command did not answer in time', { key: 'terminalTimeout' });
    }, TICK_MS);
    timer.unref();
    pty.onExit(() => setTimeout(() => finish(null), TICK_MS)); // the last bytes are still in the emulator's queue
    stop = () => finish(null);
  })().catch((err: Error) => show('', true, `The background terminal is unavailable: ${err.message}`, [], { key: 'terminalUnavailable', params: { error: err.message } }));
  return () => {
    stopped = true;
    stop();
  };
}

function safeJournal(sessionId: string, cwd: string, ctx: Ctx): string | null {
  try { return findJournal(sessionId, cwd, ctx.paths.claudeDir); } catch { return null; }
}
