// Project kit rendering: the plugin's templates filled for one project, plus the generated `kit.json` and the size baseline.
// Nothing here writes to the project; the result is what a plan compares with the disk.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KitAnswers, KitConfig, KitDetection, KitStack, KitStep, RelatedMode } from '../../shared/projectKit.ts';
import type { KitTemplate } from './osPluginManifest.ts';

export type KitRender = Map<string, { owner: 'kit' | 'seed'; content: string }>;

const GATE = 'node .claude/kit/gate.mjs';
/** The time the after-edit hook and the gate may take; the gate stops a step at `stopMs`. */
export const KIT_BUDGETS: KitConfig['budgets'] = { afterEditMs: 10000, stopMs: 90000 };
// Test files per stack, for the path-scoped tests rule.
const TEST_GLOBS: Record<KitStack, string[]> = {
  ts: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}', '**/__tests__/**'],
  python: ['**/test_*.py', '**/*_test.py'],
  go: ['**/*_test.go'],
  rust: ['tests/**/*.rs'],
};
// Ruling R5: relaxed raises the file limit only; function and complexity values wait in kit.json for /promote.
const LIMITS = {
  strict: { file: 300, ui: 400, fn: 50, complexity: 10 },
  relaxed: { file: 400, ui: 400, fn: 80, complexity: 15 },
} as const;
const STEP_NAMES: Record<KitStep, string> = { typecheck: 'Typecheck', lint: 'Lint', test: 'Unit tests', build: 'Build', e2e: 'e2e', format: 'Format' };
const RELATED: Record<RelatedMode, string | null> = {
  vitest: 'vitest related tests',
  jest: 'jest related tests',
  'node-test': 'node:test files that import the edited file',
  testmon: 'pytest --testmon',
  'pytest-name': 'pytest on `test_<name>.py`',
  go: 'go test on the edited package',
  stop: 'no tests (they run at Stop)',
  none: null,
};

/** Templates are stored under names Claude Code does not load; this gives the name they get in the project. */
export function targetPath(templatePath: string, docsDir: string): string {
  return templatePath
    .replace(/(^|\/)CLAUDE\.md\.tpl$/, '$1CLAUDE.md')
    .replace(/^claude\//, '.claude/')
    .replace(/^docs\//, `${docsDir}/`);
}

/** The content of `.claude/kit/kit.json`: what the kit's scripts and hooks read at run time. */
export function kitConfig(d: KitDetection, answers: KitAnswers, version: string): KitConfig {
  return {
    kit: version,
    stacks: d.stacks,
    commands: d.commands,
    skipped: d.skipped,
    related: d.related,
    formatter: d.formatter,
    protected: [...new Set([...d.generated, ...(answers.protected ?? [])])],
    limits: { ...LIMITS[answers.limits ?? 'strict'] },
    docsDir: d.docsDir,
    budgets: { ...KIT_BUDGETS },
  };
}

// The folder is not backticked: every backticked span in the Commands section must be a detected command.
const inDir = (cwd: string) => (cwd === '.' ? '' : ` (in ${cwd}/)`);

function commandLines(d: KitDetection): string {
  return d.commands.map((c) => `- ${STEP_NAMES[c.step]}: \`${c.run}\`${inDir(c.cwd)}`).join('\n');
}

// The contours table of `testing.md`, from what was detected.
function testingSection(d: KitDetection): string {
  const related = d.related.flatMap((r) => (RELATED[r.mode] ? [`${RELATED[r.mode]}${inDir(r.dir)}`] : []));
  const a = [...(d.formatter ? [`\`${d.formatter.run}\``] : []), ...related].join('; ') || 'nothing detected';
  const has = (step: KitStep) => d.commands.some((c) => c.step === step);
  const b = [...(['typecheck', 'lint'] as const).filter(has), 'size', 'new suppressions', 'touchpoints', ...(has('test') ? ['unit tests'] : [])].join(', ');
  const c = d.commands.filter((x) => x.step === 'build' || x.step === 'e2e').map((x) => `\`${x.run}\`${inDir(x.cwd)}`).join(', ') || 'none detected';
  const rows = [
    '| Contour | Runs | When | Budget |',
    '| --- | --- | --- | --- |',
    `| A | ${a} | after each edit (the after-edit hook) | <= 10 s |`,
    `| B | the gate: ${b} | Stop, before merging | <= 90 s |`,
    `| C | ${c} | in the background, through the test-runner agent | minutes |`,
  ];
  const skipped = d.skipped.map((s) => `${s.step} (${s.skipped})`).join(', ');
  return skipped ? `${rows.join('\n')}\n\nSkipped: ${skipped}.` : rows.join('\n');
}

// Each stack's test files under its folder; no stack, no globs.
const testGlobs = (d: KitDetection) => d.stacks.flatMap((s) => TEST_GLOBS[s.stack].map((g) => (s.dir === '.' ? g : `${s.dir}/${g}`)));

function kitVars(d: KitDetection, config: KitConfig): Record<string, string> {
  return {
    commands: commandLines(d),
    testGlobs: testGlobs(d).map((g) => `  - "${g}"`).join('\n'),
    gate: GATE,
    docsDir: d.docsDir,
    limits: `files ${config.limits.file} non-blank lines, UI components ${config.limits.ui}`,
    testing: testingSection(d),
  };
}

/** Fills the known placeholders; a placeholder alone on its line with nothing to say takes the line with it. */
function fill(text: string, vars: Record<string, string>): string {
  return text
    .replace(/^\{\{(\w+)\}\}\n/gm, (all, key: string) => (vars[key] === '' ? '' : all))
    .replace(/\{\{(\w+)\}\}/g, (all, key: string) => (Object.hasOwn(vars, key) ? vars[key] : all));
}

function applies(t: KitTemplate, d: KitDetection): boolean {
  if (t.stacks && !t.stacks.some((s) => d.stacks.some((x) => x.stack === s))) return false;
  if (t.when === 'git') return d.git;
  // A rule without globs would load in every session, so the tests rule needs a stack to scope it.
  if (t.when === 'tests') return d.commands.some((c) => c.step === 'test') && testGlobs(d).length > 0;
  if (t.when === 'migrate') return d.instructions.length > 0;
  return true;
}

// Run in a child so the count is the kit's own `size.mjs` (the one the project gets) and its code stays out of the server.
// The root comes first: `size.mjs` runs its CLI when `process.argv[1]` is its own path.
const COUNT = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, size, json] = process.argv.slice(1);
const { limits, generated } = JSON.parse(json);
const m = await import(pathToFileURL(size).href);
const out = {};
for (const file of m.projectFiles(root).sort()) {
  if (!m.isCounted(file, generated)) continue;
  const n = m.countLines(readFileSync(join(root, file), 'utf8'));
  if (n > (m.isUi(file) ? limits.ui : limits.file)) out[file] = n;
}
process.stdout.write(JSON.stringify(out));
`;

/** Files over the limit now, each capped at its current count; a kit without `size.mjs` has no baseline to seed. */
function sizeBaseline(kitDir: string, root: string, config: KitConfig): Record<string, number> {
  const size = join(kitDir, 'claude', 'kit', 'size.mjs');
  if (!existsSync(size)) return {};
  const input = JSON.stringify({ limits: config.limits, generated: config.protected });
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', COUNT, root, size, input], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as Record<string, number>;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every file the kit would write into the project at `root`, keyed by its path there. */
export function renderKit(kit: { dir: string; version: string }, root: string, d: KitDetection, answers: KitAnswers): KitRender {
  const config = kitConfig(d, answers, kit.version);
  const vars = kitVars(d, config);
  const templates = JSON.parse(readFileSync(join(kit.dir, 'files.json'), 'utf8')) as KitTemplate[];
  const out: KitRender = new Map();
  for (const t of templates.filter((x) => applies(x, d))) {
    out.set(targetPath(t.path, d.docsDir), { owner: t.owner, content: fill(readFileSync(join(kit.dir, t.path), 'utf8'), vars) });
  }
  out.set('.claude/kit/kit.json', { owner: 'kit', content: json(config) });
  out.set('.claude/kit/size-baseline.json', { owner: 'seed', content: json(sizeBaseline(kit.dir, root, config)) });
  return out;
}
