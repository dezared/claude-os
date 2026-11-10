import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { KitDetection } from '../../shared/projectKit.ts';
import { sha256 } from '../memory/util.ts';
import { kitDetect, migrationSources } from './kitDetect.ts';
import { copyFixture, KIT_FIXTURES, KIT_FIXTURES_DIR } from './kitFixtures.ts';
import { askFor, planKit, validateClaudeMd, withPackageManager } from './kitPlan.ts';

// Tool lookup is stubbed so the plan does not depend on what this machine has installed.
const INSTALLED = new Set(['npm', 'pnpm', 'yarn', 'uv', 'pytest', 'ruff', 'go', 'gofmt', 'golangci-lint', 'cargo', 'cargo-clippy', 'rustfmt', 'make']);
const which = (bin: string) => INSTALLED.has(bin);
const KIT = { dir: join(import.meta.dirname, '..', '..', 'plugins', 'project-kit', 'kit'), version: '1.0.0' };
const dirs: string[] = [];
const temp = (dir: string) => {
  dirs.push(dir);
  return dir;
};
const copy = (name: string) => temp(copyFixture(name));
const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const plan = (root: string, extra: Partial<Parameters<typeof planKit>[0]> = {}) =>
  planKit({ root, project: 'p', kit: KIT, data, action: 'install', answers: {}, level: 'minimal', which, ...extra });

/** Path and content hash of every file outside `.git`. */
function tree(root: string, dir = ''): string[] {
  return readdirSync(join(root, dir)).sort().flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name;
    if (rel === '.git') return [];
    return statSync(join(root, rel)).isDirectory() ? tree(root, rel) : [`${rel} ${sha256(readFileSync(join(root, rel), 'utf8'))}`];
  });
}

describe('planKit', () => {
  it('plan snapshot per fixture', () => {
    for (const name of KIT_FIXTURES) {
      const { plan: p } = plan(copy(name));
      const shape = { action: p.action, files: p.files.map((f) => ({ path: f.path, owner: f.owner, action: f.action })) };
      const file = join(KIT_FIXTURES_DIR, 'expected', `${name}.plan.json`);
      if (process.env.UPDATE_KIT_SNAPSHOTS === '1') writeFileSync(file, JSON.stringify(shape, null, 2) + '\n');
      assert.deepEqual(shape, JSON.parse(readFileSync(file, 'utf8')), name);
    }
  });

  it('nothing is written before apply', () => {
    const root = copy('ts-npm-vitest');
    const before = tree(root);
    const { plan: p, writes } = plan(root);
    assert.ok(writes.size > 10);
    assert.equal(p.empty, false);
    assert.equal(p.approved, false);
    assert.deepEqual(tree(root), before);
  });

  it('a claude md draft with an invented command or 61 lines is rejected with the line', () => {
    const root = copy('existing-claude-md');
    const d = kitDetect(root, which);
    const sources = [readFileSync(join(root, 'CLAUDE.md'), 'utf8')];
    const invented = '# P\n\n## Commands\n\n- Deploy: `npm run deploy`\n- Install: `npm ci`\n';
    assert.equal(validateClaudeMd(invented, d, sources), 'not a detected command: - Deploy: `npm run deploy`');
    const long = `${Array.from({ length: 61 }, (_, i) => `line ${i}`).join('\n')}\n`;
    assert.equal(validateClaudeMd(long, d, sources), 'CLAUDE.md has 61 lines; the limit is 60');
    assert.equal(validateClaudeMd(long.split('\n').slice(1).join('\n'), d, sources), null);
    assert.throws(() => plan(root, { claudeMd: invented }), (err: Error & { statusCode?: number }) => err.statusCode === 422 && err.message.includes('npm run deploy'));
    // `npm ci` occurs in the old CLAUDE.md; detected commands and the gate pass too.
    const ok = '# P\n\n## Commands\n\n- Install: `npm ci`\n- Test: `npm run test`\n- Gate: `node .claude/kit/gate.mjs`\n';
    assert.equal(validateClaudeMd(ok, d, sources), null);
    // A short span that is only part of a source command is not a command of the project.
    for (const span of ['npm', 'ci', 'run']) assert.equal(validateClaudeMd(`## Commands\n\n- X: \`${span}\`\n`, d, sources), `not a detected command: - X: \`${span}\``, span);
    // A command on a line of its own in a source, as in a fenced block, is literal too.
    assert.equal(validateClaudeMd('## Commands\n\n- Seed: `make seed`\n', d, ['Setup:\n\n```sh\n$ make seed\n```\n']), null);
  });

  it('existing instructions make the claude md entry a migration and stay out of the writes', () => {
    const root = copy('agents-md-long');
    assert.deepEqual(migrationSources(root), ['CLAUDE.md', 'AGENTS.md']);
    const bare = plan(root).plan.files.find((f) => f.path === 'CLAUDE.md');
    assert.equal(bare?.action, 'migrate');
    assert.match(bare?.reason ?? '', /CLAUDE\.md, AGENTS\.md/);
    const { plan: p, writes } = plan(root, { claudeMd: '# Inventory\n\n@AGENTS.md\n\n## Gotchas\n\n- Prices are in cents.\n' });
    const entry = p.files.find((f) => f.path === 'CLAUDE.md');
    assert.equal(entry?.action, 'migrate');
    assert.equal(entry?.reason, 'AGENTS.md is over 60 lines: its facts were merged and the import dropped');
    assert.equal(writes.get('CLAUDE.md'), '# Inventory\n\n## Gotchas\n\n- Prices are in cents.\n');
    for (const name of ['agents-md-long', 'cursor-rules']) {
      const r = copy(name);
      const w = plan(r, { claudeMd: '# P\n', rules: { '.claude/rules/api.md': '---\npaths: src/api/**/*.ts\n---\n- Validate bodies.\n' } }).writes;
      for (const src of ['AGENTS.md', '.cursorrules', '.cursor/rules/api.mdc', '.github/copilot-instructions.md']) assert.equal(w.has(src), false, `${name}: ${src}`);
    }
  });

  it('rules outside the migration targets are refused', () => {
    const root = copy('cursor-rules');
    for (const path of ['AGENTS.md', '.cursorrules', '../x.md', '.claude/rules/00-workflow.md', 'docs/rules/testing.md']) {
      assert.throws(() => plan(root, { rules: { [path]: 'x\n' } }), (err: Error & { statusCode?: number }) => err.statusCode === 422, path);
    }
    const { plan: p } = plan(root, { rules: { '.claude/rules/api.md': 'x\n', 'docs/rules/release.md': 'y\n', 'CLAUDE.local.md': 'z\n' } });
    for (const path of ['.claude/rules/api.md', 'docs/rules/release.md', 'CLAUDE.local.md']) assert.equal(p.files.find((f) => f.path === path)?.action, 'add', path);
  });

  it('balanced asks about two package managers, minimal asks nothing', () => {
    const root = copy('monorepo-ts-py');
    const d = kitDetect(root, which);
    assert.deepEqual(askFor('minimal', d), []);
    assert.deepEqual(askFor(null, d), []);
    const balanced = askFor('balanced', d);
    assert.equal(balanced.length, 2);
    assert.match(balanced[0], /package manager.*answers\.packageManager/);
    assert.match(balanced[1], /api \(python\), web \(ts\)/);
    const thorough = askFor('thorough', d);
    assert.equal(thorough.length, 4);
    assert.match(thorough[2], /300\/50\/10 or relaxed 400\/80\/15/);
    assert.match(thorough[3], /answers\.protected/);
    // The monorepo split has no answer key: the round that sends any answer settles it.
    assert.deepEqual(askFor('thorough', d, { packageManager: 'yarn', limits: 'strict', protected: [] }), []);
    assert.deepEqual(askFor('thorough', d, { limits: 'strict' }), [balanced[0], thorough[3]]);
    assert.deepEqual(plan(root, { level: 'balanced' }).plan.ask, balanced);
    assert.deepEqual(plan(root).plan.ask, []);
    const authors: KitDetection = { ...d, ambiguities: ['authors'] };
    assert.match(askFor('balanced', authors)[0], /answers\.scope "project".*"local"/);
    assert.deepEqual(askFor('balanced', authors, { scope: 'local' }), []);
  });

  it('the package manager answer replaces the detected runner before render', () => {
    const root = copy('monorepo-ts-py');
    const d = withPackageManager(kitDetect(root, which), 'npm', which);
    assert.deepEqual(d.stacks.map((s) => s.runner), [null, 'npm']);
    assert.deepEqual(d.commands.filter((c) => c.cwd === 'web').map((c) => c.run), ['npm run lint', 'npm run test', 'npm run build']);
    assert.deepEqual(d.commands.filter((c) => c.cwd === 'api').map((c) => c.run), ['ruff check', 'pytest']);
    assert.equal(d.ambiguities.includes('package-managers'), false);
    const { plan: p, writes } = plan(root, { answers: { packageManager: 'npm' }, level: 'balanced' });
    const config = JSON.parse(writes.get('.claude/kit/kit.json') ?? '') as { commands: { run: string }[]; stacks: { runner: string | null }[] };
    assert.ok(config.commands.some((c) => c.run === 'npm run lint'));
    assert.equal(config.commands.some((c) => c.run.startsWith('yarn')), false);
    assert.match(writes.get('.claude/settings.json') ?? '', /Bash\(npm run lint\*\)/);
    assert.equal(p.ask.some((line) => line.includes('package manager')), false);
    const ts = withPackageManager(kitDetect(copy('ts-npm-vitest'), which), 'pnpm', which);
    assert.ok(ts.commands.every((c) => c.run.startsWith('pnpm ')), JSON.stringify(ts.commands));
    // An answered manager this machine lacks skips the steps it would run, like any missing tool.
    const bun = plan(root, { answers: { packageManager: 'bun' } }).writes.get('.claude/kit/kit.json') ?? '';
    const bunConfig = JSON.parse(bun) as { commands: { cwd: string }[]; skipped: { step: string; skipped: string }[] };
    assert.equal(bunConfig.commands.some((c) => c.cwd === 'web'), false);
    assert.ok(bunConfig.skipped.some((s) => s.step === 'lint' && s.skipped === 'bun not found'));
    assert.throws(() => plan(root, { answers: { packageManager: 'pip' } }), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  });
});
