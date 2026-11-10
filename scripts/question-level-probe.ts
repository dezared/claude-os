// Live check of the question levels: three prompts at each level on haiku, every AskUserQuestion answered with the
// first option of each question. Costs real tokens, so it runs by hand and never in `npm test`.
// Usage: node --disable-warning=ExperimentalWarning scripts/question-level-probe.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { QuestionLevel } from '../shared/contract.ts';
import { profileBlock, QUESTION_LEVELS } from '../server/chat/profile.ts';
import { questionDenial } from '../server/chat/questionCap.ts';

type ProbeId = 'clear' | 'ambiguous-reversible' | 'ambiguous-irreversible';

export const PROBE_PROMPTS: { id: ProbeId; text: string }[] = [
  { id: 'clear', text: 'In package.json, add a script named "format" that runs "prettier --write .".' },
  { id: 'ambiguous-reversible', text: 'Add a test setup to this project.' },
  { id: 'ambiguous-irreversible', text: 'Remove the old stuff from this project for good.' },
];

// Problems found, one line per prompt; empty when the levels order the counts and minimal stays silent where it should.
export function probeVerdict(counts: Record<QuestionLevel, Record<string, number>>): string[] {
  return PROBE_PROMPTS.flatMap(({ id }, i) => {
    const [minimal, balanced, thorough] = [counts.minimal[id] ?? 0, counts.balanced[id] ?? 0, counts.thorough[id] ?? 0];
    const problems = [
      ...(minimal <= balanced && balanced <= thorough ? [] : [`minimal ${minimal}, balanced ${balanced}, thorough ${thorough} is not ordered`]),
      ...(i < 2 && minimal > 0 ? [`minimal asked ${minimal}, expected 0`] : []),
    ];
    return problems.length ? [`${id}: ${problems.join('; ')}`] : [];
  });
}

// The tools a file task needs, inside the temp project; anything else (Bash first of all) is refused.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);

function firstOptions(input: Record<string, unknown>): Record<string, string> {
  const questions = (input.questions ?? []) as { question: string; options?: { label: string }[] }[];
  return Object.fromEntries(questions.map((q) => [q.question, q.options?.[0]?.label ?? '']));
}

// One prompt at one level: the AskUserQuestion calls Claude made, the ones the cap denied included.
async function askedQuestions(level: QuestionLevel, prompt: string): Promise<number> {
  const cwd = mkdtempSync(join(tmpdir(), 'question-probe-'));
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { build: 'tsc' } }, null, 2)}\n`);
  let calls = 0;
  const canUseTool: CanUseTool = async (tool, input): Promise<PermissionResult> => {
    if (tool !== 'AskUserQuestion') return FILE_TOOLS.has(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `${tool} is not available here.` };
    const denial = questionDenial(level, calls++);
    return denial ? { behavior: 'deny', message: denial } : { behavior: 'allow', updatedInput: { ...input, answers: firstOptions(input) } };
  };
  const append = profileBlock({ name: 'Ann', language: 'en', questionLevel: level, projectsDir: cwd }, {});
  try {
    const q = query({ prompt, options: { cwd, model: 'haiku', maxTurns: 8, settingSources: [], persistSession: false, canUseTool, systemPrompt: { type: 'preset', preset: 'claude_code', append } } });
    for await (const message of q) if (message.type === 'result') break;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return calls;
}

async function main() {
  const counts = {} as Record<QuestionLevel, Record<string, number>>;
  for (const level of Object.keys(QUESTION_LEVELS) as QuestionLevel[]) {
    counts[level] = {};
    for (const { id, text } of PROBE_PROMPTS) {
      counts[level][id] = await askedQuestions(level, text);
      console.log(`${level}\t${id}\t${counts[level][id]}`);
    }
  }
  const verdict = probeVerdict(counts);
  console.log(verdict.length ? verdict.join('\n') : 'ok: minimal <= balanced <= thorough, minimal silent on the first two');
  process.exitCode = verdict.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
