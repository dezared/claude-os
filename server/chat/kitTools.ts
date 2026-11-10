// The project kit in a work tab: kit_plan stores a plan and summarises it, kit_apply writes it once the user approved it.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { KitPlanSummary } from '../../shared/projectKit.ts';
import type { Ctx } from '../context.ts';
import { fail, ok } from './dispatchTools.ts';

// In bypassPermissions or auto mode canUseTool may not run, so no card was shown and nothing approved the plan (ruling R4).
// Claude cannot change the mode itself, so the answer says who does it.
export const NOT_APPROVED = 'not approved: the plan card appears only when the tab asks for permissions; ask the user to switch this tab to the Default mode, then call kit_apply again with the same plan id';
const OUTPUT_LINES = 60;

/** Counts per action with their paths, in plan order; then the skipped tools and the questions Claude may ask. */
export function summaryText(s: KitPlanSummary): string {
  const head = `plan ${s.planId}: ${s.action} kit ${s.kit} in ${s.root}`;
  if (s.empty) return `${head}\nnothing to do`;
  const groups = new Map<string, string[]>();
  for (const f of s.files) groups.set(f.action, [...(groups.get(f.action) ?? []), `  ${f.path}${f.reason ? ` (${f.reason})` : ''}`]);
  return [
    head,
    ...[...groups].flatMap(([action, lines]) => [`${action} ${lines.length}:`, ...lines]),
    ...s.skipped.map((k) => `skipped ${k.step}: ${k.skipped}`),
    ...s.ask.map((q) => `ask: ${q}`),
  ].join('\n');
}

// The gate prints its verdict first, so the head is what matters.
function clip(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= OUTPUT_LINES) return text;
  return [...lines.slice(0, OUTPUT_LINES), `(${lines.length - OUTPUT_LINES} more lines: run node .claude/kit/gate.mjs in the project to see them all)`].join('\n');
}

const errorText = (err: unknown) => {
  const e = err as Error & { statusCode?: number };
  return e.statusCode === 403 ? NOT_APPROVED : e.message;
};

const ANSWERS = z.object({
  scope: z.enum(['project', 'local']).optional().describe('Where the kit hooks go: .claude/settings.json or .claude/settings.local.json'),
  limits: z.enum(['strict', 'relaxed']).optional(),
  packageManager: z.string().optional().describe('npm, pnpm, yarn or bun'),
  protected: z.array(z.string()).optional().describe('Globs to protect beyond the generated folders'),
}).describe('Answers to the plan\'s ask lines');

export const kitTools = (ctx: Ctx, tabId: string) => [
  tool('kit_plan', 'Plan the project kit for the project of this tab: detects the stack, renders the kit and compares it with the files there. Writes nothing. Answer: the plan id, the files per action, skipped tools and the ask lines. Ask the user only what the ask lines list, then plan again with answers. An entry "migrate" needs a CLAUDE.md draft in claudeMd. Then call kit_apply with the plan id.', {
    action: z.enum(['install', 'remove']).optional().describe('Defaults to install, which also updates an installed kit'),
    claudeMd: z.string().optional().describe('The CLAUDE.md draft for a migrate entry: at most 60 lines, commands only as detected or found in the old instructions'),
    rules: z.record(z.string(), z.string()).optional().describe('Migrated rule files by path: .claude/rules/<name>.md, <docsDir>/rules/<name>.md or CLAUDE.local.md'),
    answers: ANSWERS.optional(),
  }, async (input) => {
    if (!ctx.kit) return fail('the project kit is not available');
    try {
      return ok(summaryText(ctx.kit.plan(tabId, input)));
    } catch (err) {
      return fail(errorText(err));
    }
  }, { annotations: { readOnlyHint: true } }),

  tool('kit_apply', 'Write a planned project kit into the project. The user sees the plan on a permission card and approves it there; then the project\'s gate runs once. Answer: the number of files written and the gate output. Never retry an apply the user denied; a stale or used plan needs a new kit_plan.', {
    planId: z.string().describe('The plan id from kit_plan'),
  }, async ({ planId }) => {
    if (!ctx.kit) return fail('the project kit is not available');
    try {
      return ok(clip(await ctx.kit.apply(planId)));
    } catch (err) {
      return fail(errorText(err));
    }
  }),
];
