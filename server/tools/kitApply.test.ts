import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { KIT_APPLY_TOOL, type KitLock, type KitPlan } from '../../shared/projectKit.ts';
import type { ChatApi } from '../context.ts';
import { initSchema } from '../journal/db.ts';
import { sha256 } from '../memory/util.ts';
import { makeKit } from '../memory/testkit.ts';
import { copyFixture, KIT_FIXTURES } from './kitFixtures.ts';
import { applyKit, staleReason } from './kitApply.ts';
import { planKit } from './kitPlan.ts';
import { kitDetect } from './kitDetect.ts';
import { kitConfig } from './kitRender.ts';
import { kitSettings } from './kitSettings.ts';
import { createProjectKit, GATE_TIMEOUT_MS, runGate } from './projectKit.ts';

const INSTALLED = new Set(['npm', 'pnpm', 'yarn', 'uv', 'pytest', 'ruff', 'go', 'gofmt', 'golangci-lint', 'cargo', 'cargo-clippy', 'rustfmt', 'make']);
const which = (bin: string) => INSTALLED.has(bin);
const KIT = { dir: join(import.meta.dirname, '..', '..', 'plugins', 'project-kit', 'kit'), version: '1.0.0' };
const dirs: string[] = [];
const temp = (dir: string) => {
  dirs.push(dir);
  return dir;
};
const copy = (name: string) => temp(copyFixture(name));
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const gate = async () => 'gate: green';
const audits: string[] = [];
const deps = (data: string) => ({ data, audit: (action: string, target: string) => void audits.push(`${action} ${target}`), gate });

type PlanInput = Partial<Parameters<typeof planKit>[0]>;
function planned(root: string, data: string, extra: PlanInput = {}) {
  return { ...planKit({ root, project: 'p', kit: KIT, data, action: 'install', answers: {}, level: 'minimal', which, ...extra }), tabId: null };
}
async function install(root: string, data: string, extra: PlanInput = {}) {
  const stored = planned(root, data, extra);
  return { stored, result: await applyKit(stored, deps(data)) };
}

function tree(root: string, dir = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name;
    if (rel === '.git') continue;
    if (statSync(join(root, rel)).isDirectory()) for (const [k, v] of tree(root, rel)) out.set(k, v);
    else out.set(rel, sha256(readFileSync(join(root, rel), 'utf8')));
  }
  return out;
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const lockOf = (root: string) => JSON.parse(read(root, '.claude/kit/lock.json')) as KitLock;
// Fixtures with instructions of other tools get a CLAUDE.md draft, which is what the kit tab sends.
const draftFor = (root: string) => (planned(root, temp(mkdtempSync(join(tmpdir(), 'kit-d-')))).plan.files.some((f) => f.action === 'migrate') ? { claudeMd: '# Project\n\n## Gotchas\n\n- Keep it short.\n' } : {});

/** A copy of the shipped kit with one rule changed in its last line: a later kit version. */
function kitV11(lastLine: string): { dir: string; version: string } {
  const dir = temp(mkdtempSync(join(tmpdir(), 'kit-v11-')));
  cpSync(KIT.dir, dir, { recursive: true });
  const rule = join(dir, 'claude', 'rules', '00-workflow.md');
  const lines = readFileSync(rule, 'utf8').trimEnd().split('\n');
  writeFileSync(rule, `${[...lines.slice(0, -1), lastLine].join('\n')}\n`);
  return { dir, version: '1.1.0' };
}

describe('applyKit', () => {
  it('apply then re-plan is empty', async () => {
    for (const name of KIT_FIXTURES) {
      const root = copy(name);
      const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
      const { result } = await install(root, data, draftFor(root));
      assert.equal(result.gate, 'gate: green');
      const again = planned(root, data);
      assert.equal(again.plan.empty, true, `${name}: ${JSON.stringify(again.plan.files.filter((f) => f.action !== 'keep'))}`);
      assert.equal(again.writes.size, 0, name);
    }
  });

  it('every byte outside the plan is unchanged', async () => {
    for (const name of ['ts-npm-vitest', 'monorepo-ts-py', 'existing-claude-md', 'py-uv-pytest']) {
      const root = copy(name);
      const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
      const before = tree(root);
      const config = execFileSync('git', ['config', '--list', '--local'], { cwd: root, encoding: 'utf8' });
      const { stored, result } = await install(root, data, draftFor(root));
      const paths = new Set(stored.plan.files.map((f) => f.path));
      assert.deepEqual(new Set(result.written), new Set(stored.writes.keys()));
      const after = tree(root);
      for (const [path, hash] of before) if (!paths.has(path)) assert.equal(after.get(path), hash, `${name}: ${path}`);
      for (const path of after.keys()) assert.ok(before.has(path) || paths.has(path), `${name}: new file ${path} outside the plan`);
      for (const path of [...before.keys()].filter((p) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|uv\.lock|pyproject\.toml)$/.test(p))) assert.equal(paths.has(path), false, path);
      assert.equal(execFileSync('git', ['config', '--list', '--local'], { cwd: root, encoding: 'utf8' }), config, name);
    }
  });

  it('other tools\' instruction files stay byte-identical', async () => {
    for (const name of ['cursor-rules', 'agents-md-long']) {
      const root = copy(name);
      const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
      const sources = ['AGENTS.md', '.cursorrules', '.cursor/rules/api.mdc'].filter((p) => existsSync(join(root, p)));
      const before = sources.map((p) => read(root, p));
      await install(root, data, { claudeMd: '# P\n', rules: { '.claude/rules/api.md': '---\npaths: src/api/**/*.ts\n---\n- Validate bodies.\n' } });
      assert.deepEqual(sources.map((p) => read(root, p)), before, name);
      assert.equal(read(root, 'CLAUDE.md'), '# P\n');
      assert.ok(existsSync(join(root, '.claude/rules/api.md')));
    }
  });

  it('update merges, flags, keeps deletions and seeds', async () => {
    const root = copy('ts-npm-vitest');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    await install(root, data);
    const rule = '.claude/rules/00-workflow.md';
    writeFileSync(join(root, rule), read(root, rule).replace('# Workflow\n', '# Workflow\n\nOur own line.\n'));
    unlinkSync(join(root, '.claude/skills/handoff/SKILL.md'));
    writeFileSync(join(root, 'CLAUDE.md'), `${read(root, 'CLAUDE.md')}\n- A gotcha of ours.\n`);
    const v11 = kitV11('- Always ask first: push, deleting data, a new dependency, CI config.');
    const update = planned(root, data, { kit: v11 });
    const action = (path: string) => update.plan.files.find((f) => f.path === path)?.action;
    assert.equal(update.plan.action, 'update');
    assert.equal(action(rule), 'merge');
    assert.equal(action('.claude/skills/handoff/SKILL.md'), 'skip');
    assert.equal(update.writes.has('.claude/skills/handoff/SKILL.md'), false);
    assert.equal(action('CLAUDE.md'), undefined);
    assert.equal(update.writes.has('CLAUDE.md'), false);
    await applyKit(update, deps(data));
    assert.match(read(root, rule), /Our own line\.[\s\S]*Always ask first/);
    assert.equal(existsSync(join(root, '.claude/skills/handoff/SKILL.md')), false);
    assert.equal(lockOf(root).kit, '1.1.0');
    assert.equal(planned(root, data, { kit: v11 }).plan.empty, true);
    // An edit on the line the next version changes conflicts: flagged, the file left as it is.
    const edited = read(root, rule).replace('Always ask first', 'We ask first');
    writeFileSync(join(root, rule), edited);
    const v12 = { ...kitV11('- Ask before: push, deleting data, a new dependency, CI config.'), version: '1.2.0' };
    const conflict = planned(root, data, { kit: v12 });
    const entry = conflict.plan.files.find((f) => f.path === rule);
    assert.equal(entry?.action, 'needs-merge');
    assert.equal(entry?.reason, 'local edits conflict with the new kit version');
    await applyKit(conflict, deps(data));
    assert.equal(read(root, rule), edited);
    assert.equal(planned(root, data, { kit: v12 }).plan.files.find((f) => f.path === rule)?.action, 'needs-merge');
  });

  it('remove takes only hash-matching kit files', async () => {
    const root = copy('ts-npm-vitest');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    mkdirSync(join(root, '.claude'));
    const userSettings = { permissions: { allow: ['Bash(make deploy)'] }, model: 'opus' };
    writeFileSync(join(root, '.claude/settings.json'), `${JSON.stringify(userSettings, null, 2)}\n`);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    await install(root, data);
    const agent = '.claude/agents/reviewer.md';
    writeFileSync(join(root, agent), `${read(root, agent)}\nOur note.\n`);
    const remove = planned(root, data, { action: 'remove' });
    assert.equal(remove.plan.action, 'remove');
    assert.equal(remove.plan.files.find((f) => f.path === agent)?.action, 'keep');
    const { written, gate: out } = await applyKit(remove, deps(data));
    assert.equal(out, '');
    assert.ok(written.includes('.claude/kit/gate.mjs'));
    assert.match(read(root, agent), /Our note\./);
    for (const seed of ['CLAUDE.md', '.claude/rules/20-mistakes.md', 'docs/rules/common-mistakes.md', '.claude/kit/size-baseline.json']) assert.ok(existsSync(join(root, seed)), seed);
    for (const gone of ['.claude/kit/gate.mjs', '.claude/kit/hooks', '.claude/kit/kit.json', '.claude/kit/lock.json', '.claude/rules/00-workflow.md', '.claude/skills']) assert.equal(existsSync(join(root, gone)), false, gone);
    assert.deepEqual(JSON.parse(read(root, '.claude/settings.json')), userSettings);
    assert.equal(read(root, '.gitignore'), 'node_modules/\n');
  });

  it('a lock records what was written when a write fails', async () => {
    const root = copy('go');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    mkdirSync(join(root, 'docs/rules/testing.md'), { recursive: true });
    const stored = planned(root, data);
    await assert.rejects(applyKit(stored, deps(data)));
    const lock = lockOf(root);
    assert.ok(lock.files['CLAUDE.md']);
    assert.ok(lock.files['docs/specs/TEMPLATE.md']);
    assert.equal(lock.files['docs/rules/testing.md'], undefined);
    assert.equal(lock.files['.claude/kit/gate.mjs'], undefined);
    assert.deepEqual(lock.settings.allow, []);
  });

  it('never writes through a symlink inside the project', async () => {
    const root = copy('go');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    const outside = temp(mkdtempSync(join(tmpdir(), 'kit-outside-')));
    symlinkSync(outside, join(root, '.claude'));
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    const stored = planned(root, data, { claudeMd: '# P\n' });
    const entry = (path: string) => stored.plan.files.find((f) => f.path === path);
    assert.deepEqual([entry('.claude/kit/gate.mjs')?.action, entry('.claude/kit/gate.mjs')?.reason], ['skip', '.claude is a symlink']);
    assert.deepEqual([entry('CLAUDE.md')?.action, entry('CLAUDE.md')?.reason], ['skip', 'CLAUDE.md is a symlink']);
    assert.deepEqual([...stored.writes.keys()].filter((p) => p === 'CLAUDE.md' || p.startsWith('.claude/')), []);
    await applyKit(stored, deps(data));
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(read(root, 'AGENTS.md'), '# Agents\n');
    assert.ok(existsSync(join(root, 'docs/specs/TEMPLATE.md')));
  });

  it('a symlink made after the plan stops the write', async () => {
    const root = copy('go');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    const outside = temp(mkdtempSync(join(tmpdir(), 'kit-outside-')));
    const stored = planned(root, data);
    symlinkSync(outside, join(root, 'docs'));
    await assert.rejects(applyKit(stored, deps(data)), /docs is a symlink/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('seeds stay when the docs folder moves, and a lock without owners still reads', async () => {
    const root = copy('ts-npm-vitest');
    const data = temp(mkdtempSync(join(tmpdir(), 'kit-data-')));
    await install(root, data);
    assert.equal(lockOf(root).files['docs/rules/common-mistakes.md']?.owner, 'seed');
    assert.equal(lockOf(root).files['docs/specs/TEMPLATE.md']?.owner, 'kit');
    writeFileSync(join(root, 'mkdocs.yml'), 'site_name: x\n');
    const moved = planned(root, data);
    const action = (path: string) => moved.plan.files.find((f) => f.path === path)?.action;
    assert.equal(action('docs/specs/TEMPLATE.md'), 'remove');
    for (const seed of ['docs/rules/common-mistakes.md', 'docs/rules/testing.md']) assert.notEqual(action(seed), 'remove', seed);
    assert.equal(moved.writes.has('docs/rules/common-mistakes.md'), false);
    rmSync(join(root, 'mkdocs.yml'));
    // A lock written before entries had an owner: nothing to do, and remove still keeps the seeds.
    const old = lockOf(root);
    for (const entry of Object.values(old.files)) delete entry.owner;
    writeFileSync(join(root, '.claude/kit/lock.json'), `${JSON.stringify(old, null, 2)}\n`);
    assert.equal(planned(root, data).plan.empty, true);
    const remove = planned(root, data, { action: 'remove' });
    assert.equal(remove.writes.has('docs/rules/common-mistakes.md'), false);
  });

  it('the stale check names the changed path', () => {
    const root = copy('go');
    const stored = planned(root, temp(mkdtempSync(join(tmpdir(), 'kit-data-'))));
    assert.equal(staleReason(stored.hashes, root), null);
    writeFileSync(join(root, '.gitignore'), 'x\n');
    assert.equal(staleReason(stored.hashes, root), 'stale plan: .gitignore changed; call kit_plan again');
  });
});

describe('createProjectKit', () => {
  function setup(root: string, gateOut: (root: string) => Promise<string> = gate) {
    const kit = makeKit({ projectForCwd: () => 'proj' });
    dirs.push(kit.base);
    // The permission requests open in tab t1, as the session holds them while a card waits.
    const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
    const get = (tabId: string) => {
      if (tabId !== 't1') throw new Error('Tab not found');
      return { pendingPermission: (requestId: string) => pending.get(requestId) ?? null };
    };
    kit.ctx.chat = { tabInfo: () => ({ cwd: root, project: 'proj', kind: 'work' }), get } as unknown as ChatApi;
    let active: { id: string; dir: string; version: string } | null = { id: 'project-kit', ...KIT };
    const api = createProjectKit(kit.ctx, () => active, gateOut);
    const card = (planId: string, tool = KIT_APPLY_TOOL) => {
      const requestId = `r${pending.size}`;
      pending.set(requestId, { tool, input: { planId } });
      return requestId;
    };
    const setActive = (next: typeof active) => {
      active = next;
    };
    return { kit, api, card, setActive };
  }
  const status = (err: unknown) => (err as { statusCode?: number }).statusCode;

  it('the gate budget and the apply wait both sit below the stop hook timeout', () => {
    const d = kitDetect(copy('go'), which);
    const stop = kitSettings(d, {}).hooks.Stop[0] as { hooks: { timeout: number }[] };
    const { stopMs } = kitConfig(d, {}, '1.0.0').budgets;
    assert.ok(stopMs < GATE_TIMEOUT_MS, `${stopMs} < ${GATE_TIMEOUT_MS}`);
    assert.ok(GATE_TIMEOUT_MS < stop.hooks[0].timeout * 1000, `${GATE_TIMEOUT_MS} < ${stop.hooks[0].timeout} s`);
  });

  it('approval needs the pending kit_apply card of that plan in its tab', async () => {
    const root = copy('go');
    const { kit, api, card } = setup(root);
    const { planId } = api.plan('t1', {});
    const approve = (body: object) => kit.app.inject({ method: 'POST', url: `/api/project-kit/plans/${planId}/approve`, payload: body });
    assert.equal((await approve({})).statusCode, 403);
    assert.equal((await approve({ requestId: 'nope' })).statusCode, 403);
    assert.equal((await approve({ requestId: card(planId, 'Bash') })).statusCode, 403);
    assert.equal((await approve({ requestId: card('another-plan') })).statusCode, 403);
    await assert.rejects(api.apply(planId), (err) => status(err) === 403);
    assert.deepEqual((await approve({ requestId: card(planId) })).json(), { ok: true });
    assert.match(await api.apply(planId), /^\d+ files written/);
  });

  it('apply refuses a plan once the kit plugin is disabled or changed', async () => {
    const root = copy('go');
    const { api, card, setActive } = setup(root);
    const first = api.plan('t1', {});
    api.approve(first.planId, card(first.planId));
    setActive(null);
    await assert.rejects(api.apply(first.planId), (err) => status(err) === 409 && (err as Error).message === 'enable the project-kit plugin first');
    setActive({ id: 'project-kit', ...KIT });
    const second = api.plan('t1', {});
    api.approve(second.planId, card(second.planId));
    setActive({ id: 'project-kit', ...KIT, version: '2.0.0' });
    await assert.rejects(api.apply(second.planId), (err) => status(err) === 409 && /kit changed/.test((err as Error).message));
    assert.equal(existsSync(join(root, '.claude')), false);
  });

  it('analytics lists the project right after the apply', async () => {
    const root = copy('go');
    const { kit, api, card } = setup(root);
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    kit.ctx.db = db;
    kit.addProject('proj', root);
    const url = '/api/analytics/kit?from=2026-11-01&to=2026-11-10';
    assert.deepEqual((await kit.app.inject({ method: 'GET', url })).json(), []);
    const { planId } = api.plan('t1', {});
    api.approve(planId, card(planId));
    await api.apply(planId);
    assert.deepEqual((await kit.app.inject({ method: 'GET', url })).json().map((r: { project: string }) => r.project), ['proj']);
  });

  it('a project nested in a parent git repo gets a working gate and hooks', async () => {
    const parent = copy('nested-in-git');
    const root = join(parent, 'app');
    const { api, card } = setup(root, runGate);
    const { planId } = api.plan('t1', {});
    api.approve(planId, card(planId));
    assert.match(await api.apply(planId), /\ngate: green/);
    // A suppression elsewhere in the parent repo is not this project's.
    writeFileSync(join(parent, 'tools/check.py'), 'import os  # noqa\n');
    assert.match(await runGate(root), /^gate: green/);
    const hook = spawnSync(process.execPath, [join(root, '.claude/kit/hooks/protect-files.mjs')], { cwd: root, encoding: 'utf8', input: JSON.stringify({ cwd: root, tool_input: { file_path: join(root, '.env') } }) });
    assert.equal(hook.status, 2, hook.stdout + hook.stderr);
    assert.match(hook.stderr, /^protect-files: \.env is protected/);
  });

  it('apply needs the approval, then writes, audits and runs the gate', async () => {
    const root = copy('go');
    const { kit, api, card } = setup(root);
    const summary = api.plan('t1', {});
    assert.equal('diff' in (summary.files[0] ?? {}), false);
    await assert.rejects(api.apply(summary.planId), (err) => status(err) === 403);
    const got = await kit.app.inject({ method: 'GET', url: `/api/project-kit/plans/${summary.planId}` });
    assert.equal(got.statusCode, 200);
    assert.ok((got.json() as KitPlan).files.some((f) => f.diff.includes('+++ b/.claude/kit/kit.json')));
    const ok = await kit.app.inject({ method: 'POST', url: `/api/project-kit/plans/${summary.planId}/approve`, payload: { requestId: card(summary.planId) } });
    assert.deepEqual(ok.json(), { ok: true });
    const out = await api.apply(summary.planId);
    assert.match(out, /^\d+ files written\ngate: green$/);
    assert.ok(kit.audits.some((a) => a.action === 'project.kit.apply' && a.target === join(root, '.claude/kit/kit.json')));
    assert.deepEqual(kit.topics, ['projectKit']);
    assert.equal((await kit.app.inject({ method: 'GET', url: '/api/project-kit/status' })).json().kit.version, '1.0.0');
    await assert.rejects(api.apply(summary.planId), (err) => status(err) === 404);
    const again = api.plan('t1', {});
    assert.equal(again.empty, true);
    api.approve(again.planId, card(again.planId));
    assert.equal(await api.apply(again.planId), 'nothing to do');
    assert.equal((await kit.app.inject({ method: 'GET', url: '/api/analytics/kit?from=2026-11-01&to=2026-11-10' })).statusCode, 200);
  });

  it('a stale plan is rejected', async () => {
    const root = copy('go');
    const { api, card } = setup(root);
    const summary = api.plan('t1', {});
    api.approve(summary.planId, card(summary.planId));
    writeFileSync(join(root, '.gitignore'), 'bin/\n');
    await assert.rejects(api.apply(summary.planId), (err) => status(err) === 409 && (err as Error).message === 'stale plan: .gitignore changed; call kit_plan again');
    assert.equal(existsSync(join(root, '.claude')), false);
  });

  it('refuses the claude os repo through a symlink', () => {
    const outside = temp(mkdtempSync(join(tmpdir(), 'kit-link-')));
    const { kit, api } = setup(join(outside, 'link'));
    mkdirSync(join(kit.paths.repo, 'server'), { recursive: true });
    symlinkSync(join(kit.paths.repo, 'server'), join(outside, 'link'));
    assert.throws(() => api.plan('t1', {}), (err) => status(err) === 422);
    assert.equal(existsSync(join(kit.paths.repo, 'server', '.claude')), false);
  });

  it('refuses without the enabled kit plugin', () => {
    const kit = makeKit({ projectForCwd: () => 'proj' });
    dirs.push(kit.base);
    kit.ctx.chat = { tabInfo: () => ({ cwd: copy('go'), project: 'proj', kind: 'work' }) } as unknown as ChatApi;
    const api = createProjectKit(kit.ctx, () => null, gate);
    assert.throws(() => api.plan('t1', {}), (err) => status(err) === 409 && (err as Error).message === 'enable the project-kit plugin first');
  });

  it('non-git folder gets a dirty-flag stop gate', async () => {
    const root = copy('unknown');
    assert.equal(existsSync(join(root, '.git')), false);
    let ran = '';
    const { api, card } = setup(root, async (r) => {
      ran = r;
      return 'gate: green';
    });
    const summary = api.plan('t1', {});
    const paths = summary.files.map((f) => f.path);
    assert.ok(paths.includes('.claude/kit/kit.json') && paths.includes('.claude/settings.json'));
    api.approve(summary.planId, card(summary.planId));
    assert.match(await api.apply(summary.planId), /gate: green/);
    assert.equal(ran, root);
    const settings = JSON.parse(read(root, '.claude/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.match(settings.hooks.Stop[0].hooks[0].command, /stop-gate\.mjs/);
    assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /after-edit\.mjs/);
    assert.equal((JSON.parse(read(root, '.claude/kit/kit.json')) as { kit: string }).kit, '1.0.0');
  });
});
