// The kits screen's report: every plugin folder with a kit, the projects with their kit, the apply history.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { KitSetsReport } from '../../shared/projectKit.ts';
import { makeKit } from '../memory/testkit.ts';
import { kitContents, kitHistory, registerKitSets } from './kitSets.ts';
import type { KitTemplate } from './osPluginManifest.ts';

const SHIPPED = join(import.meta.dirname, '..', '..', 'plugins', 'project-kit');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('kitContents sorts the shipped template index by what each file becomes', () => {
  const index = JSON.parse(readFileSync(join(SHIPPED, 'kit', 'files.json'), 'utf8')) as KitTemplate[];
  const c = kitContents(index);
  assert.equal(c.claudeMd, true);
  assert.deepEqual(c.rules, ['00-workflow', '10-code-standard', '20-mistakes', 'tests']);
  assert.deepEqual(c.agents, ['reviewer', 'scout', 'test-runner']);
  assert.deepEqual(c.skills, ['spec', 'feature', 'split-file', 'compound', 'handoff']);
  assert.deepEqual(c.checks, ['gate', 'size', 'touchpoints', 'metrics']);
  assert.deepEqual(c.hooks, ['protect-files', 'after-edit', 'stop-gate', 'briefing']);
  assert.ok(c.docs.includes('docs/rules/common-mistakes.md'));
});

test('kitHistory keeps the rows that parse', () => {
  const rows = [
    { at: 3, target: 'a', diff: JSON.stringify({ kit: 'project-kit', version: '1.0.0', action: 'update', files: 4 }) },
    { at: 2, target: 'b', diff: 'not json' },
    { at: 1, target: 'c', diff: JSON.stringify({ kit: 'x', version: '1.0.0', action: 'explode' }) },
  ];
  assert.deepEqual(kitHistory(rows), [{ at: 3, project: 'a', kit: 'project-kit', version: '1.0.0', action: 'update', files: 4 }]);
});

test('GET /api/project-kit/kits lists kit plugins, projects with their kit and the history', async () => {
  const kit = makeKit();
  dirs.push(kit.base);
  // The test kit's base is its Claude OS checkout too: the projects live in a folder of their own.
  kit.paths.repo = join(kit.base, 'repo');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, action TEXT, target TEXT, diff TEXT)');
  db.prepare('INSERT INTO audit_log (at, action, target, diff) VALUES (?, ?, ?, ?)').run(5, 'project.kit', 'with', JSON.stringify({ kit: 'lean', version: '1.1.0', action: 'install', files: 30 }));
  db.prepare('INSERT INTO audit_log (at, action, target, diff) VALUES (?, ?, ?, ?)').run(6, 'project.kit.apply', '/x/CLAUDE.md', 'diff');
  kit.ctx.db = db;
  const withKit = join(kit.base, 'with');
  kit.addProject('with', withKit);
  kit.addProject('without', join(kit.base, 'without'));
  kit.addProject('os', join(kit.paths.repo, 'sub'));
  mkdirSync(join(withKit, '.claude', 'kit'), { recursive: true });
  writeFileSync(join(withKit, '.claude', 'kit', 'lock.json'), JSON.stringify({ kit: '1.1.0', id: 'lean', installedAt: 7, files: {}, settings: {} }));
  const plain = join(kit.base, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'plugin.json'), JSON.stringify({ id: 'plain', name: 'Plain', description: 'x', version: '1.0.0', author: 'x' }));
  const folders = [{ id: 'project-kit', dir: SHIPPED }, { id: 'plain', dir: plain }];
  registerKitSets(kit.ctx, () => folders, () => [{ id: 'project-kit', dir: join(SHIPPED, 'kit'), version: '1.0.0' }]);
  const r = (await kit.app.inject({ method: 'GET', url: '/api/project-kit/kits' })).json() as KitSetsReport;
  assert.equal(r.default, 'project-kit');
  assert.deepEqual(r.kits.map((k) => [k.id, k.contents.agents.length]), [['project-kit', 3]]);
  assert.deepEqual(r.projects.map((p) => [p.key, p.kit, p.installedAt]), [['with', { id: 'lean', version: '1.1.0' }, 7], ['without', null, null]]);
  assert.deepEqual(r.history, [{ at: 5, project: 'with', kit: 'lean', version: '1.1.0', action: 'install', files: 30 }]);
});
