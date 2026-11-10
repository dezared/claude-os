// The question level as a hard limit: AskUserQuestion calls allowed per user message, on top of the level's text.
import type { QuestionLevel } from '../../shared/contract.ts';

export const QUESTION_CAPS: Record<QuestionLevel, number | null> = { minimal: 1, balanced: 2, thorough: null };

// `asked`: AskUserQuestion calls already allowed since the last user message. Null when this one may go through.
export function questionDenial(level: QuestionLevel | null, asked: number): string | null {
  const cap = level ? QUESTION_CAPS[level] : null;
  return cap !== null && asked >= cap ? `Question level ${level}: decide, state the assumption, continue.` : null;
}
