import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { findPaths, isImagePath } from '@/lib/filePaths';
import { cn } from '@/lib/format';
import { highlightCode } from '@/lib/highlight';
import type { TerminalRun } from '@/lib/types';
import { ImageThumbs, PathLink } from './ToolCall';

const STYLED_CAP = 200_000; // the screen is kept up to 2000 lines of 90: past that it is plain text
const MAX_THUMBS = 4;
const ANSI = ['#27272a', '#e5766d', '#8fc99a', '#d9bd7f', '#9dbbdc', '#c3aedb', '#7fc8d0', '#d4d4d8', '#71717a', '#f09a92', '#a8dcb1', '#e8d09a', '#b8d0ea', '#d6c5e8', '#9edbe2', '#fafafa'];
const CUBE = [0, 95, 135, 175, 215, 255];

function paletteColor(c: number | string): string {
  if (typeof c === 'string') return c;
  if (c < 16) return ANSI[c];
  if (c >= 232) {
    const v = 8 + (c - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const n = c - 16;
  return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`;
}

function runStyle(r: TerminalRun): CSSProperties {
  const fg = r.fg === undefined ? undefined : paletteColor(r.fg);
  const bg = r.bg === undefined ? undefined : paletteColor(r.bg);
  return {
    color: r.inverse ? bg ?? 'var(--color-bg)' : fg,
    backgroundColor: r.inverse ? fg ?? 'var(--color-soft)' : bg,
    fontWeight: r.bold ? 600 : undefined,
    opacity: r.dim ? 0.6 : undefined,
  };
}

type Tone = 'ok' | 'warn' | 'bad';
const WORD = /(?<![\p{L}\p{N}_-])(OK|PASS(?:ED)?|DONE|SUCCESS|WARN(?:ING)?|FAIL(?:ED)?|ERROR)(?![\p{L}\p{N}_-])|[✓✔⚠✗✘]/gu;
const VALUE = /^\s*[^\s:/][^:/]{0,40}:\s+(enabled|connected|success|disabled|failed|error)(?![\p{L}\p{N}_-])/iu;
const KEY = /^(\s*)([^\s:/][^:/]{0,40}:)(?=\s|$)/u;
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

function toneOf(word: string): Tone {
  if (/^(OK|PASS|PASSED|DONE|SUCCESS|ENABLED|CONNECTED|✓|✔)$/i.test(word)) return 'ok';
  if (/^(WARN|WARNING|DISABLED|⚠)$/i.test(word)) return 'warn';
  return 'bad';
}

type Mark = { from: number; to: number; wrap: (children: ReactNode) => ReactNode };

/** Links first, then badges: what is already a link stays one thing. Only places that do not overlap. */
function marksOf(text: string, plain: boolean): Mark[] {
  const marks: Mark[] = [];
  const free = (from: number, to: number) => !marks.some((m) => from < m.to && m.from < to);
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    marks.push({ from: m.index, to: m.index + url.length, wrap: (c) => <a key={m.index} href={url} target="_blank" rel="noreferrer" className="file-link">{c}</a> });
  }
  for (const f of findPaths(text)) {
    if (free(f.index, f.index + f.length)) marks.push({ from: f.index, to: f.index + f.length, wrap: (c) => <PathLink key={f.index} path={f.path} line={f.line} label="">{c}</PathLink> });
  }
  const badge = (from: number, word: string) => {
    if (free(from, from + word.length)) marks.push({ from, to: from + word.length, wrap: (c) => <span key={from} className="term-badge" data-tone={toneOf(word)}>{c}</span> });
  };
  for (const m of text.matchAll(WORD)) badge(m.index, m[0]);
  if (plain) {
    const value = VALUE.exec(text);
    if (value) badge(value[0].length - value[1].length, value[1]);
    const key = KEY.exec(text);
    if (key && free(key[1].length, key[0].length)) marks.push({ from: key[1].length, to: key[0].length, wrap: (c) => <span key={key[1].length} className="term-key">{c}</span> });
  }
  return marks.sort((a, b) => a.from - b.from);
}

function coloured(text: string, runs: TerminalRun[], from: number, to: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = from;
  for (const r of runs) {
    if (r.to <= at || r.from >= to) continue;
    const a = Math.max(r.from, at);
    const b = Math.min(r.to, to);
    if (a > at) out.push(text.slice(at, a));
    out.push(<span key={a} style={runStyle(r)}>{text.slice(a, b)}</span>);
    at = b;
  }
  if (at < to) out.push(text.slice(at, to));
  return out;
}

// One line, memoized by its text and colours: a screen that changes every tick renders only the lines that changed.
const Line = memo(function Line({ text, runs, plain, head }: { text: string; runs: TerminalRun[]; plain: boolean; head: boolean; runsKey: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of marksOf(text, plain)) {
    parts.push(...coloured(text, runs, at, m.from));
    parts.push(m.wrap(coloured(text, runs, m.from, m.to)));
    at = m.to;
  }
  parts.push(...coloured(text, runs, at, text.length));
  return <span className={head ? 'font-semibold text-fg' : undefined}>{parts}</span>;
}, (a, b) => a.text === b.text && a.runsKey === b.runsKey && a.plain === b.plain && a.head === b.head);

const noRuns: TerminalRun[] = [];

/** Output of a terminal: its own colours, links, badges, pictures below. Without colours a whole JSON or diff is highlighted as such. */
export const TerminalText = memo(function TerminalText({ text, runs = noRuns, className, testId }: { text: string; runs?: TerminalRun[]; className?: string; testId?: string }) {
  const plain = runs.length === 0;
  const big = text.length > STYLED_CAP;
  const code = useMemo(() => {
    if (!plain || big) return null;
    if (/^(diff --git |--- .*\n\+\+\+ |@@ )/m.test(text)) return highlightCode(text, 'diff');
    if (/^[[{]/.test(text)) {
      try {
        JSON.parse(text);
        return highlightCode(text, 'json');
      } catch { /* looks like it, is not */ }
    }
    return null;
  }, [text, plain, big]);
  const lines = useMemo(() => (big || code !== null ? [] : text.split('\n')), [text, big, code]);
  const byLine = useMemo(() => {
    const map = new Map<number, TerminalRun[]>();
    for (const r of runs) {
      const row = map.get(r.line);
      if (row) row.push(r);
      else map.set(r.line, [r]);
    }
    return map;
  }, [runs]);
  const images = useMemo(() => (big ? [] : [...new Set(findPaths(text).map((f) => f.path))].filter(isImagePath).slice(0, MAX_THUMBS)), [text, big]);
  const box = cn('selectable max-h-96 overflow-auto p-2.5 font-mono text-[11px] leading-snug text-soft', className);
  return (
    <>
      {big ? (
        <pre data-testid={testId} className={box}>{text}</pre>
      ) : code !== null ? (
        <pre data-testid={testId} className={box}><code className="hljs" dangerouslySetInnerHTML={{ __html: code }} /></pre>
      ) : (
        <pre data-testid={testId} className={box}>
          {lines.map((line, i) => {
            const own = byLine.get(i) ?? noRuns;
            return (
              <span key={i}>
                <Line text={line} runs={own} runsKey={own === noRuns ? '' : JSON.stringify(own)} plain={plain} head={plain && i === 0 && !line.includes(':')} />
                {'\n'}
              </span>
            );
          })}
        </pre>
      )}
      {images.length > 0 && <div className="px-2.5 pb-2.5 [&>div]:m-0"><ImageThumbs paths={images} /></div>}
    </>
  );
});
