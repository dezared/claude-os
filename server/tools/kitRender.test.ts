import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { KitConfig } from '../../shared/projectKit.ts';
import { kitDetect } from './kitDetect.ts';
import { copyFixture, KIT_FIXTURES } from './kitFixtures.ts';
import { kitConfig, renderKit, targetPath } from './kitRender.ts';

const KIT = { dir: join(import.meta.dirname, '..', '..', 'plugins', 'project-kit', 'kit'), version: '1.0.0' };
// Tool lookup is stubbed so the result does not depend on what this machine has installed.
const INSTALLED = new Set(['npm', 'pnpm', 'yarn', 'uv', 'pytest', 'ruff', 'go', 'gofmt', 'golangci-lint', 'cargo', 'cargo-clippy', 'rustfmt', 'make']);
const which = (bin: string) => INSTALLED.has(bin);

const roots: string[] = [];
const copy = (name: string) => {
  const root = copyFixture(name);
  roots.push(root);
  return root;
};
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** The backticked spans of the Commands section of a rendered CLAUDE.md. */
function commandsIn(claudeMd: string): string[] {
  const section = claudeMd.split('\n## ').find((s) => s.startsWith('Commands\n')) ?? '';
  return [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

describe('kitRender', () => {
  it('renders loadable names from template names', () => {
    assert.equal(targetPath('claude/rules/00-workflow.md', 'docs'), '.claude/rules/00-workflow.md');
    assert.equal(targetPath('docs/specs/TEMPLATE.md', 'dev-docs'), 'dev-docs/specs/TEMPLATE.md');
    assert.equal(targetPath('docs/specs/TEMPLATE.md', 'docs'), 'docs/specs/TEMPLATE.md');
    assert.equal(targetPath('CLAUDE.md.tpl', 'docs'), 'CLAUDE.md');
    assert.equal(targetPath('claude/kit/hooks/stop-gate.mjs', 'docs'), '.claude/kit/hooks/stop-gate.mjs');
  });

  it('rendered claude md is at most 60 lines and every command is detected', () => {
    for (const name of KIT_FIXTURES) {
      const root = copy(name);
      const d = kitDetect(root, which);
      const claudeMd = renderKit(KIT, root, d, {}).get('CLAUDE.md')?.content ?? '';
      assert.ok(claudeMd.split('\n').length <= 60, `${name}: ${claudeMd.split('\n').length} lines`);
      const allowed = new Set([...d.commands.map((c) => c.run), 'node .claude/kit/gate.mjs']);
      const listed = commandsIn(claudeMd);
      for (const cmd of listed) assert.ok(allowed.has(cmd), `${name}: not a detected command: ${cmd}`);
      for (const c of d.commands) assert.ok(listed.includes(c.run), `${name}: missing ${c.run}`);
    }
  });

  it('a project with tests gets a path-scoped tests rule from its stacks', () => {
    const rule = (name: string) => {
      const root = copy(name);
      return renderKit(KIT, root, kitDetect(root, which), {}).get('.claude/rules/tests.md');
    };
    const ts = rule('ts-npm-vitest');
    assert.equal(ts?.owner, 'seed');
    assert.match(ts?.content ?? '', /^---\npaths:\n {2}- "\*\*\/\*\.\{test,spec\}\.\{ts,tsx,js,jsx,mjs,cjs\}"\n {2}- "\*\*\/__tests__\/\*\*"\n---\n# Tests\n/);
    assert.match(ts?.content ?? '', /docs\/rules\/testing\.md/);
    const mono = rule('monorepo-ts-py')?.content ?? '';
    assert.deepEqual([...mono.matchAll(/^ {2}- "(.+)"$/gm)].map((m) => m[1]), ['api/**/test_*.py', 'api/**/*_test.py', 'web/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}', 'web/**/__tests__/**']);
    assert.match(rule('go')?.content ?? '', /^ {2}- "\*\*\/\*_test\.go"$/m);
    // No stack, no globs: an unscoped rule would load in every session, so there is none.
    assert.equal(rule('make-only'), undefined);
    assert.equal(rule('unknown'), undefined);
  });

  it('templates render to loadable paths with no placeholder left', () => {
    const root = copy('docs-site');
    const files = renderKit(KIT, root, kitDetect(root, which), {});
    for (const [path, { content }] of files) {
      assert.ok(!path.startsWith('claude/') && !path.endsWith('.tpl') && !path.startsWith('docs/'), path);
      assert.doesNotMatch(content, /\{\{(commands|gate|docsDir|testing|limits|testGlobs)\}\}/, path);
    }
    for (const path of ['.claude/kit/gate.mjs', '.claude/kit/hooks/stop-gate.mjs', 'dev-docs/rules/testing.md', '.claude/kit/kit.json']) assert.ok(files.has(path), path);
    assert.equal(files.get('.claude/kit/kit.json')?.owner, 'kit');
    assert.equal(files.get('.claude/kit/size-baseline.json')?.owner, 'seed');
    assert.equal(files.get('CLAUDE.md')?.owner, 'seed');
    assert.match(files.get('.claude/rules/20-mistakes.md')?.content ?? '', /dev-docs\/rules\/common-mistakes\.md/);
  });

  it('size baseline lists files over the limit with their counts', () => {
    const root = copy('ts-npm-vitest');
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n\n`).join('');
    mkdirSync(join(root, 'gen'));
    writeFileSync(join(root, 'src', 'big.ts'), lines(301));
    writeFileSync(join(root, 'src', 'small.ts'), lines(300));
    writeFileSync(join(root, 'src', 'view.tsx'), lines(350));
    writeFileSync(join(root, 'src', 'wide.tsx'), lines(401));
    writeFileSync(join(root, 'src', 'big.test.ts'), lines(500));
    writeFileSync(join(root, 'gen', 'api.ts'), lines(500));
    const files = renderKit(KIT, root, kitDetect(root, which), { protected: ['gen/'] });
    assert.deepEqual(JSON.parse(files.get('.claude/kit/size-baseline.json')?.content ?? ''), { 'src/big.ts': 301, 'src/wide.tsx': 401 });
    const relaxed = renderKit(KIT, root, kitDetect(root, which), { protected: ['gen/'], limits: 'relaxed' });
    assert.deepEqual(JSON.parse(relaxed.get('.claude/kit/size-baseline.json')?.content ?? ''), { 'src/wide.tsx': 401 });
  });

  it('kit json records skipped tools', () => {
    const root = copy('go');
    const d = kitDetect(root, (bin) => bin !== 'golangci-lint' && which(bin));
    const config = JSON.parse(renderKit(KIT, root, d, {}).get('.claude/kit/kit.json')?.content ?? '') as KitConfig;
    assert.deepEqual(config.skipped, [{ step: 'lint', skipped: 'golangci-lint not found' }]);
    assert.equal(config.kit, '1.0.0');
    assert.ok(!config.commands.some((c) => c.step === 'lint'));
  });

  it('limits follow the answer and protected adds to the generated folders', () => {
    const d = kitDetect(copy('ts-npm-vitest'), which);
    assert.deepEqual(kitConfig(d, {}, '1.0.0').limits, { file: 300, ui: 400, fn: 50, complexity: 10 });
    const relaxed = kitConfig(d, { limits: 'relaxed', protected: ['gen/'] }, '1.0.0');
    assert.deepEqual(relaxed.limits, { file: 400, ui: 400, fn: 80, complexity: 15 });
    assert.deepEqual(relaxed.protected, ['node_modules/', 'dist/', 'gen/']);
    assert.deepEqual(relaxed.budgets, { afterEditMs: 10000, stopMs: 90000 });
  });
});
