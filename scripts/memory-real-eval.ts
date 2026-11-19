// Does Claude find facts of real notes in a large vault, with the search by meaning on and off? A copy of a real
// vault's projects/ (read only; the copy lives in a temp dir) is grown with generated filler notes in the same projects,
// then each question is asked the way memory-claude-eval.ts asks it. The questions stay outside the repository: they
// quote private notes. Not part of the gate: it calls Claude.
// questions.json: [{ "project": "...", "q": "...", "expect": ["regex", ...], "source": "note-name" }]
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-real-eval.ts <projects dir> <questions.json> <model dir> [notes, default 40000]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SemanticStatus } from '../shared/memorySemantic.ts';
import { registerMemory, type MemoryApiExt } from '../server/memory/index.ts';
import { makeKit, type TestKit } from '../server/memory/testkit.ts';
import { setWikiManaged } from '../server/memory/wikiManaged.ts';
import { noteText } from './memory-bench.ts';
import { appendText, ask } from './memory-claude-eval.ts';

interface RealQuestion { project: string; q: string; expect: string[]; source: string }

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Filler in every project with notes, in proportion to its real notes, up to `total` in all.
function grow(kit: TestKit, source: string, total: number): string[] {
  const projects = join(kit.paths.vault, 'projects');
  mkdirSync(projects, { recursive: true });
  spawnSync('cp', ['-a', `${source}/.`, projects]);
  const sizes = readdirSync(projects).map((key) => [key, readdirSync(join(projects, key)).filter((f) => f.endsWith('.md')).length] as const).filter(([, n]) => n > 0);
  const real = sizes.reduce((a, [, n]) => a + n, 0);
  const rand = rng(7);
  for (const [key, n] of sizes) {
    const filler = Math.round(((total - real) * n) / real);
    for (let i = 0; i < filler; i++) writeFileSync(join(projects, key, `${key}-note-${i}.md`), noteText(key, i, filler, rand));
    kit.addProject(key, join(kit.base, 'work', key));
    setWikiManaged(kit.paths, key, true);
  }
  console.log(`vault: ${real} real notes in ${sizes.length} projects, grown to about ${total}`);
  return sizes.map(([key]) => key);
}

const semantic = async (kit: TestKit) => (await kit.app.inject({ method: 'GET', url: '/api/memory/semantic' })).json() as SemanticStatus;

async function setUp(source: string, model: string, total: number): Promise<TestKit> {
  const kit = makeKit();
  grow(kit, source, total);
  const root = join(kit.paths.data, 'memory-semantic');
  mkdirSync(root, { recursive: true });
  symlinkSync(model, join(root, 'model'));
  writeFileSync(join(root, 'installed'), 'eval\n');
  const t = performance.now();
  registerMemory(kit.ctx);
  await (kit.ctx.memory as MemoryApiExt).ready;
  let s = await semantic(kit);
  while (!(s.total > 0 && s.indexed === s.total)) {
    await new Promise((r) => setTimeout(r, 2000));
    s = await semantic(kit);
  }
  console.log(`${s.indexed} vectors built in ${((performance.now() - t) / 1000).toFixed(0)} s`);
  return kit;
}

async function round(kit: TestKit, label: string, questions: RealQuestion[]) {
  const append = appendText();
  const rows = [`| # | source note | correct | memory_search | other tools | input tokens, all calls | peak context | turns |`, '|---|---|---|---|---|---|---|---|'];
  let correct = 0;
  let cost = 0;
  for (const [i, q] of questions.entries()) {
    const r = await ask(kit, { project: q.project, q: q.q, expect: q.expect.map((e) => new RegExp(e, 'i')) }, append);
    if (r.found) correct++;
    cost += r.cost;
    rows.push(`| ${i + 1} | ${q.source} | ${r.found ? 'y' : 'n'} | ${r.searches} | ${r.reads} | ${r.input} | ${r.peak} | ${r.turns} |`);
    console.log(`${label} ${i + 1}. ${r.found ? 'CORRECT' : 'WRONG'} tools: ${r.calls.join(', ')}\n   -> ${r.answer.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  console.log(`\n${label}: correct ${correct}/${questions.length}; cost $${cost.toFixed(2)}\n${rows.join('\n')}\n`);
}

async function main() {
  const [source, questionsFile, model, notes] = process.argv.slice(2);
  if (!source || !questionsFile || !model) throw new Error('usage: memory-real-eval.ts <projects dir> <questions.json> <model dir> [notes]');
  const questions = JSON.parse(readFileSync(questionsFile, 'utf8')) as RealQuestion[];
  const kit = await setUp(source, model, Number(notes ?? 40_000));
  try {
    await round(kit, 'semantic on', questions);
    await kit.app.inject({ method: 'POST', url: '/api/memory/semantic/disable' });
    await round(kit, 'semantic off', questions);
  } finally {
    await kit.close();
  }
}

await main();
