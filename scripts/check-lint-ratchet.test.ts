import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeBase, ratchetViolations, type OxlintConfig } from './check-lint-ratchet.ts';

const LINES = { skipBlankLines: true, skipComments: true };
const cap = (files: string[], max: number) => ({ files, rules: { 'max-lines': ['error', { max, ...LINES }] } });
const config = (max: number, overrides: OxlintConfig['overrides'] = []): OxlintConfig => ({
  rules: { 'max-lines': ['error', { max, ...LINES }], complexity: ['error', 10] },
  overrides,
});

test('red on a raised base limit', () => {
  const found = ratchetViolations(config(300), config(301));
  assert.equal(found.length, 1);
  assert.match(found[0], /max-lines/);
});

test('red on a new override', () => {
  const found = ratchetViolations(config(300), config(300, [cap(['server/new.ts'], 400)]));
  assert.equal(found.length, 1);
  assert.match(found[0], /server\/new\.ts/);
});

test('red on a raised override cap', () => {
  const base = config(300, [cap(['server/chat/session.ts'], 760)]);
  const found = ratchetViolations(base, config(300, [cap(['server/chat/session.ts'], 761)]));
  assert.equal(found.length, 1);
  assert.match(found[0], /server\/chat\/session\.ts.*max-lines/);
});

test('red on a rule turned off or downgraded to warn', () => {
  const base: OxlintConfig = { rules: { complexity: 'error', 'max-depth': ['error', 4] } };
  const current: OxlintConfig = { rules: { complexity: 'warn', 'max-depth': 'off' } };
  const found = ratchetViolations(base, current);
  assert.equal(found.length, 2);
  assert.match(found[0], /complexity/);
  assert.match(found[1], /max-depth/);
});

test('green on a lowered cap and on a deleted override', () => {
  const base = config(300, [cap(['server/chat/session.ts'], 760), cap(['server/tools/admin.ts'], 621)]);
  assert.deepEqual(ratchetViolations(base, config(300, [cap(['server/chat/session.ts'], 700)])), []);
});

test('red on a rule removed, an override rule turned off and a new ignore pattern', () => {
  const base: OxlintConfig = { rules: { complexity: ['error', 10] }, overrides: [cap(['a.ts'], 400)], ignorePatterns: ['dist/'] };
  const current: OxlintConfig = {
    overrides: [{ files: ['a.ts'], rules: { 'max-lines': ['error', { max: 400, ...LINES }], 'max-depth': 'off' } }],
    ignorePatterns: ['dist/', 'server/**'],
  };
  const found = ratchetViolations(base, current);
  assert.equal(found.length, 3);
  assert.match(found.join('\n'), /complexity[\s\S]*max-depth[\s\S]*server\/\*\*/);
});

test('red on a category downgraded', () => {
  const found = ratchetViolations({ categories: { correctness: 'error' } }, { categories: { correctness: 'warn' } });
  assert.equal(found.length, 1);
  assert.match(found[0], /correctness/);
});

test('override identity ignores the order of files', () => {
  const base = config(300, [cap(['b.ts', 'a.ts'], 400)]);
  assert.deepEqual(ratchetViolations(base, config(300, [cap(['a.ts', 'b.ts'], 400)])), []);
});

test('mergeBase equals HEAD on main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    assert.equal(mergeBase(dir), git('rev-parse', 'HEAD'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red on a top-level rule added as off or warn', () => {
  const found = ratchetViolations({ rules: {} }, { rules: { 'no-unused-vars': 'off', 'no-debugger': 'warn', eqeqeq: 'error' } });
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /no-unused-vars: error -> off[\s\S]*no-debugger: error -> warn/);
});

test('red on a dropped plugin, the default set counting when plugins is absent', () => {
  assert.match(ratchetViolations({ plugins: ['typescript', 'react'] }, { plugins: ['typescript'] }).join('\n'), /plugins: dropped react/);
  assert.match(ratchetViolations({}, { plugins: ['typescript', 'oxc'] }).join('\n'), /plugins: dropped unicorn/);
  assert.deepEqual(ratchetViolations({}, { plugins: ['unicorn', 'typescript', 'oxc', 'react'] }), []);
  assert.deepEqual(ratchetViolations({ plugins: ['unicorn', 'typescript', 'oxc'] }, {}), []);
});
