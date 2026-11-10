import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateManifest, walk, type KitTemplate } from './osPluginManifest.ts';

const PLUGIN = join(import.meta.dirname, '..', '..', 'plugins', 'project-kit');
const KIT = join(PLUGIN, 'kit');
const read = (rel: string) => readFileSync(join(KIT, rel), 'utf8');
const lines = (rel: string) => read(rel).trimEnd().split('\n').length;
const frontmatter = (rel: string): Record<string, string> => {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(read(rel));
  assert.ok(head, `${rel} has frontmatter`);
  return Object.fromEntries(head[1].split('\n').map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
};

describe('project kit templates', () => {
  it('templates fit their budgets', () => {
    assert.ok(lines('CLAUDE.md.tpl') <= 60, 'CLAUDE.md.tpl');
    assert.ok(lines('claude/rules/00-workflow.md') + lines('claude/rules/10-code-standard.md') <= 30, 'workflow and code standard');
    assert.ok(lines('claude/rules/20-mistakes.md') <= 10, '20-mistakes.md');
    const skills = readdirSync(join(KIT, 'claude', 'skills'));
    assert.deepEqual(skills.sort(), ['compound', 'feature', 'handoff', 'spec', 'split-file']);
    for (const name of skills) {
      const rel = `claude/skills/${name}/SKILL.md`;
      assert.ok(lines(rel) <= 40, rel);
      const fm = frontmatter(rel);
      assert.equal(fm.name, name, rel);
      assert.equal(fm['disable-model-invocation'], 'true', rel);
      assert.ok(fm.description, rel);
    }
    const models: Record<string, string> = {};
    for (const file of readdirSync(join(KIT, 'claude', 'agents'))) {
      const fm = frontmatter(`claude/agents/${file}`);
      assert.equal(fm.name, file.replace(/\.md$/, ''), file);
      models[fm.name] = fm.model;
    }
    assert.deepEqual(models, { reviewer: 'inherit', scout: 'haiku', 'test-runner': 'sonnet' });
  });

  it('no template has a loadable name', () => {
    const files = walk(KIT) ?? [];
    assert.ok(files.length > 0);
    for (const rel of files) {
      assert.ok(!`/${rel}`.includes('/.claude/'), rel);
      assert.ok(!/(^|\/)CLAUDE(\.local)?\.md$/.test(rel), rel);
    }
    const rows = JSON.parse(read('files.json')) as KitTemplate[];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(existsSync(join(KIT, row.path)), row.path);
      assert.ok(row.owner === 'kit' || row.owner === 'seed', row.path);
    }
    assert.equal(new Set(rows.map((r) => r.path)).size, rows.length, 'no path is listed twice');
    const { errors, manifest } = validateManifest('project-kit', PLUGIN);
    assert.deepEqual(errors, []);
    assert.equal(manifest?.kit, 'kit');
  });

  it('the manifest check rejects bad rows of the template index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-manifest-'));
    try {
      cpSync(PLUGIN, dir, { recursive: true });
      const rows = [
        'nope',
        { path: '../outside.md', owner: 'kit' },
        { path: '/etc/passwd', owner: 'kit' },
        { path: 'claude/rules/00-workflow.md', owner: 'boss' },
        { path: 'claude/rules/10-code-standard.md', owner: 'kit', when: 'sometimes' },
        { path: 'claude/rules/20-mistakes.md', owner: 'seed', stacks: ['cobol'] },
        { path: 'claude/missing.md', owner: 'kit' },
        { path: 'docs/plans/README.md', owner: 'kit', stacks: ['ts'], when: 'tests' },
      ];
      writeFileSync(join(dir, 'kit', 'files.json'), JSON.stringify(rows));
      const { errors } = validateManifest('project-kit', dir);
      assert.deepEqual(errors, [
        'kit/files.json: row 1 needs a path and an owner',
        'kit/files.json: ../outside.md must be a relative path inside kit/',
        'kit/files.json: /etc/passwd must be a relative path inside kit/',
        'kit/files.json: claude/rules/00-workflow.md has owner boss; use kit or seed',
        'kit/files.json: claude/rules/10-code-standard.md has when sometimes; use git, tests, migrate',
        'kit/files.json: claude/rules/20-mistakes.md has stacks outside ts, python, go, rust',
        'kit/files.json: claude/missing.md is missing',
      ]);
      writeFileSync(join(dir, 'kit', 'files.json'), '{ "path": "x" }');
      assert.deepEqual(validateManifest('project-kit', dir).errors, ['kit/files.json must be a list of rows']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('workflow rule names the always-ask list', () => {
    assert.match(read('claude/rules/00-workflow.md'), /always ask, at any question level: push or remotes, deleting data, a new dependency, lint\/format\/CI config/);
  });
});
