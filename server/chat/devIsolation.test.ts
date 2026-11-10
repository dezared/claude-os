// Dev kit isolation for product sessions: temp repos only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx } from '../context.ts';
import { devIsolation, isProductCwd, withDevIsolation } from './devIsolation.ts';
import { probeOptions } from './probe.ts';

const base = mkdtempSync(join(tmpdir(), 'claude-os-isolation-'));
after(() => rmSync(base, { recursive: true, force: true }));
const repo = join(base, 'repo');
const real = realpathSync(base) + '/repo';
mkdirSync(join(repo, '.claude', 'skills', 'spec'), { recursive: true });
writeFileSync(join(repo, '.claude', 'skills', 'spec', 'SKILL.md'), '---\nname: spec\n---\n');
mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
const paths = { repo, root: join(repo, 'root'), service: join(repo, 'service'), setup: join(repo, 'setup') };
const excludes = (r: string) => [`${r}/CLAUDE.md`, `${r}/CLAUDE.local.md`, `${r}/.claude/rules/**`];

test('excludes the repo claude md, local md and rules', () => {
  assert.deepEqual(devIsolation(repo).claudeMdExcludes, excludes(real));
});

test('turns off every dev skill and denies every dev agent', () => {
  const first = devIsolation(repo);
  assert.deepEqual(first.skillOverrides, { spec: 'off' });
  assert.deepEqual(first.permissions.deny, ['Agent(reviewer)']);
  mkdirSync(join(repo, '.claude', 'skills', 'feature'));
  assert.equal(devIsolation(repo).skillOverrides.feature, 'off');
  rmSync(join(repo, '.claude', 'skills', 'feature'), { recursive: true });
});

test('no dev kit gives empty lists', () => {
  const bare = join(base, 'bare');
  mkdirSync(bare);
  const iso = devIsolation(bare);
  assert.deepEqual(iso.skillOverrides, {});
  assert.deepEqual(iso.permissions.deny, []);
  assert.deepEqual(iso.claudeMdExcludes, excludes(realpathSync(bare)));
});

test('isolates a nested cwd and a symlinked repo path', () => {
  assert.equal(isProductCwd(paths, join(paths.root, 'docs', 'x')), true);
  assert.equal(isProductCwd(paths, paths.service), true);
  assert.equal(isProductCwd(paths, paths.setup), true);
  assert.equal(isProductCwd(paths, join(repo, 'rootless')), false);
  const link = join(base, 'link');
  symlinkSync(repo, link);
  assert.deepEqual(devIsolation(link).claudeMdExcludes, excludes(real));
  const linked = { repo: link, root: join(link, 'root'), service: join(link, 'service'), setup: join(link, 'setup') };
  assert.deepEqual(withDevIsolation(linked, join(link, 'root'))?.claudeMdExcludes, excludes(real));
});

test('leaves a dev cwd alone', () => {
  const settings = { autoMemoryDirectory: '/v' };
  assert.equal(withDevIsolation(paths, repo, settings), settings);
  assert.equal(withDevIsolation(paths, join(repo, '.worktrees', 'w1'), settings), settings);
  assert.equal(withDevIsolation(paths, repo), undefined);
});

test('merges with service settings', () => {
  const merged = withDevIsolation(paths, paths.service, { autoMemoryEnabled: false, env: { A: '1' }, permissions: { deny: ['Edit(/x/**)'] } });
  assert.equal(merged?.autoMemoryEnabled, false);
  assert.deepEqual(merged?.env, { A: '1' });
  assert.deepEqual(merged?.permissions?.deny, ['Edit(/x/**)', 'Agent(reviewer)']);
  assert.deepEqual(merged?.skillOverrides, { spec: 'off' });
  assert.deepEqual(merged?.claudeMdExcludes, excludes(real));
});

test('probe options are isolated for a root cwd', () => {
  const ctx = { paths: { ...paths, claudeBin: 'claude' } } as unknown as Ctx;
  const inRoot = probeOptions(ctx, paths.root, true).settings as Settings;
  assert.equal(inRoot.disableAllHooks, true);
  assert.deepEqual(inRoot.claudeMdExcludes, excludes(real));
  assert.deepEqual(probeOptions(ctx, repo, true).settings, { disableAllHooks: true });
});
