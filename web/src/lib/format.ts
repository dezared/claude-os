import { locale, t } from './i18n';
import type { SessionStatus, TokenCounts } from './types';

const formatters = new Map<string, Intl.NumberFormat>();

function num(n: number, digits: number): string {
  const key = `${locale()}|${digits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), { maximumFractionDigits: digits });
    formatters.set(key, f);
  }
  return f.format(n);
}

export function fmtInt(n: number): string {
  return num(n, 0);
}

/** Compact number in the interface language: 38,3 mln in ru / 38.3M in en. */
export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return t('unit.billion', { n: num(n / 1e9, 2) });
  if (abs >= 1e6) return t('unit.million', { n: num(n / 1e6, abs >= 1e8 ? 0 : abs >= 1e7 ? 1 : 2) });
  if (abs >= 1e4) return t('unit.thousand', { n: num(n / 1e3, abs >= 1e5 ? 0 : 1) });
  return num(n, 0);
}

/** Sum that the app calls "tokens": cache read is shown separately, never part of it. */
export function tokenSum(c: TokenCounts): number {
  return c.input + c.output + c.cacheWrite;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function fmtAgo(ts: number | null, now = Date.now()): string {
  if (ts == null) return t('common.noData');
  const d = now - ts;
  if (d < 2 * MIN) return t('ago.now');
  if (d < HOUR) return t('ago.min', { n: Math.floor(d / MIN) });
  if (d < DAY) return t('ago.hour', { n: Math.floor(d / HOUR) });
  if (d < 60 * DAY) return t('ago.day', { n: Math.floor(d / DAY) });
  const date = new Date(ts);
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year }).replace('.', '');
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "2026-11-04" as a local date, never parsed as UTC. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmtDay(day: string): string {
  return parseDay(day).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }).replace('.', '');
}

export function toDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function statusLabel(s: SessionStatus): string {
  return t(`status.${s}`);
}

export function isLive(s: SessionStatus): boolean {
  return s !== 'ended';
}

export function fmtUsd(n: number): string {
  return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 }).format(n)}`;
}

export function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, '~');
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
