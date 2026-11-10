import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { KitCommand } from '../../shared/projectKit.ts';
import { kitDetect } from './kitDetect.ts';
import { requirementNames, targetNames, tomlTables } from './kitDetectStacks.ts';
import { copyFixture, KIT_FIXTURES, KIT_FIXTURES_DIR } from './kitFixtures.ts';
import { treeHash } from './osPlugins.ts';

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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `from` names something real: a binary the stub finds, or a key present in the named file. */
function sourceExists(root: string, from: string): boolean {
  if (from.startsWith('PATH:')) return which(from.slice('PATH:'.length));
  const [file, key] = from.split('#');
  const text = readFileSync(join(root, file), 'utf8');
  const name = basename(file);
  if (name === 'package.json') return key.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), JSON.parse(text)) !== undefined;
  if (name === 'pyproject.toml') return [...tomlTables(text)].some((t) => t === key || t.startsWith(`${key}.`));
  if (/^requirements.*\.txt$/.test(name)) return requirementNames(text).has(key);
  return targetNames(name, text).has(key);
}

describe('kitDetect', () => {
  it('detection matches the snapshot for every fixture', () => {
    for (const name of KIT_FIXTURES) {
      const detected = kitDetect(copy(name), which);
      const file = join(KIT_FIXTURES_DIR, 'expected', `${name}.detect.json`);
      if (process.env.UPDATE_KIT_SNAPSHOTS === '1') writeFileSync(file, JSON.stringify(detected, null, 2) + '\n');
      assert.deepEqual(detected, JSON.parse(readFileSync(file, 'utf8')), name);
    }
  });

  it('every command has a source', () => {
    for (const name of KIT_FIXTURES) {
      const root = copy(name);
      const { commands, formatter } = kitDetect(root, which);
      for (const c of [...commands, ...(formatter ? [formatter] : [])]) assert.ok(sourceExists(root, c.from), `${name}: ${c.run} from ${c.from}`);
    }
  });

  it('a missing tool removes its step and says why', () => {
    const detected = kitDetect(copy('go'), (bin) => bin !== 'golangci-lint' && which(bin));
    assert.equal(detected.commands.some((c) => c.step === 'lint'), false);
    assert.deepEqual(detected.skipped, [{ step: 'lint', skipped: 'golangci-lint not found' }]);
  });

  it('make targets win over inferred commands', () => {
    const root = copy('make-only');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'm', scripts: { test: 'node --test' } }));
    const test = kitDetect(root, which).commands.filter((c) => c.step === 'test');
    assert.deepEqual(test, [{ step: 'test', run: 'make test', cwd: '.', from: 'Makefile#test' }]);
  });

  it('typescript without a typecheck script gets tsc --noEmit', () => {
    const detected = kitDetect(copy('ts-pnpm-node-test'), which);
    const typecheck: KitCommand = { step: 'typecheck', run: 'pnpm exec tsc --noEmit', cwd: '.', from: 'package.json#devDependencies.typescript' };
    assert.deepEqual(detected.commands.find((c) => c.step === 'typecheck'), typecheck);
    assert.deepEqual(detected.related, [{ dir: '.', mode: 'node-test' }]);
  });

  it('an unknown stack has no steps', () => {
    const detected = kitDetect(copy('unknown'), which);
    assert.deepEqual(detected.stacks, []);
    assert.deepEqual(detected.commands, []);
    assert.equal(detected.git, false);
  });

  it('a published docs folder moves the kit docs', () => {
    assert.equal(kitDetect(copy('docs-site'), which).docsDir, 'dev-docs');
    assert.equal(kitDetect(copy('ts-npm-vitest'), which).docsDir, 'docs');
  });

  it('two lockfiles and a monorepo are ambiguities', () => {
    const detected = kitDetect(copy('monorepo-ts-py'), which);
    assert.ok(detected.ambiguities.includes('package-managers'));
    assert.ok(detected.ambiguities.includes('monorepo'));
    assert.deepEqual(detected.stacks.map((s) => s.dir).sort(), ['api', 'web']);
  });

  it('a second author in 90 days is an ambiguity', () => {
    const root = copy('go');
    writeFileSync(join(root, 'extra.txt'), 'x\n');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Other', GIT_AUTHOR_EMAIL: 'other@example.com', GIT_COMMITTER_NAME: 'Other', GIT_COMMITTER_EMAIL: 'other@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'second');
    assert.ok(kitDetect(root, which).ambiguities.includes('authors'));
    assert.ok(!kitDetect(copy('go'), which).ambiguities.includes('authors'));
  });

  it('detection writes nothing', () => {
    for (const name of KIT_FIXTURES) {
      const root = copy(name);
      const before = treeHash(root);
      kitDetect(root, which);
      assert.equal(treeHash(root), before, name);
    }
  });
});
