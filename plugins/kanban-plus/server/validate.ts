// Every value a card or board takes from outside, checked before anything is written.
import { httpError } from './fail.ts';
import { COLUMNS, PRIORITIES, TYPES, type CardType, type Column, type Priority } from './types.ts';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_NAME = 80; // an agent or a board
const MAX_GOAL = 500;
const MAX_LABEL = 40;
const MAX_LABELS = 12;
const MAX_ESTIMATE = 1000;
const MAX_COMMENT = 10_000;

function member<T extends string>(list: readonly T[], what: string) {
  return (value: unknown): T => {
    if (!list.includes(value as T)) throw httpError(400, `${what} is one of ${list.join(', ')}`);
    return value as T;
  };
}

function text(what: string, max: number) {
  return (value: unknown): string => {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || clean.length > max) throw httpError(400, `${what} is text, up to ${max} characters`);
    return clean;
  };
}

export const column = member<Column>(COLUMNS, 'column');
export const priority = member<Priority>(PRIORITIES, 'priority');
export const cardType = member<CardType>(TYPES, 'type');
export const title = text('a title', MAX_TITLE);
export const boardName = text('a board name', MAX_NAME);
export const agentName = text('an agent', MAX_NAME);
export const comment = text('a comment', MAX_COMMENT);

export function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION) throw httpError(400, `a description is text, up to ${MAX_DESCRIPTION} characters`);
  return value;
}

export function goal(value: unknown): string | undefined {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_GOAL) throw httpError(400, `a board goal is text, up to ${MAX_GOAL} characters`);
  return value.trim() || undefined;
}

/** Lower case, no commas or spaces at the ends, each once, in the order given. */
export function labels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LABELS) throw httpError(400, `labels are a list of up to ${MAX_LABELS} words`);
  const clean = value.map((l) => (typeof l === 'string' ? l.trim().toLowerCase().replace(/[,\s]+/g, '-') : ''));
  if (clean.some((l) => !l || l.length > MAX_LABEL)) throw httpError(400, `a label is a word, up to ${MAX_LABEL} characters`);
  return [...new Set(clean)];
}

/** null takes the estimate away. */
export function estimate(value: unknown): number | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_ESTIMATE) throw httpError(400, `an estimate is a number of points from 0 to ${MAX_ESTIMATE}`);
  return value;
}
