import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LIBRARY_ICON_INK, type IconLibrary, type OsPluginPlan, type OsPluginsReport, type OsPluginUi, type ProjectIcons } from '../../shared/contract.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { registerTools } from './index.ts';
import { sha256 } from '../memory/util.ts';
import { createApprovals } from './approvals.ts';
import { createMcp } from './mcp.ts';
import { MANIFEST, createOsPlugins, validateManifest } from './osPlugins.ts';
import { createSkills } from './skills.ts';
import { revealArgv } from './platform.ts';
import { mediaType } from './projectFiles.ts';
import { renderLibraryIcon, sanitizeSvg } from './projectIcons.ts';

const REPO = join(import.meta.dirname, '..', '..');
let kit: TestKit;

beforeEach(() => {
  kit = makeKit();
});
afterEach(() => kit.close());

async function req<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const res = await kit.app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as T };
}
const ok = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
  const r = await req<T>(method, url, payload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

const manifest = (over: object = {}) => ({ id: 'full', name: 'Full', description: 'All kinds', version: '1.0.0', author: 'Test', ...over });
const CONTAINS = {
  skills: ['helper'],
  hooks: [{ event: 'Stop', command: 'bash "{pluginDir}/run.sh"' }, { event: 'PostToolUse', matcher: 'Edit', command: 'echo edited' }],
  mcp: { docs: { command: 'node', args: ['{pluginDir}/server.js'], env: { API_TOKEN: 'secret-value-1234' } } },
};

function plugin(id = 'full', over: object = {}) {
  const dir = join(kit.paths.config, 'plugins', id);
  kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id, contains: CONTAINS, ...over })));
  kit.write(join(dir, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: Helps\n---\nbody\n');
  kit.write(join(dir, 'skills', 'helper', 'scripts', 'x.sh'), 'echo x\n');
  kit.write(join(dir, 'run.sh'), 'echo must-not-run > "$(dirname "$0")/ran"\n');
  return dir;
}

// A stand-in for the CLI that really changes the config file, as `claude mcp` does, adding the type it adds.
function fakeClaude() {
  kit.write(kit.paths.claudeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const [, , , cmd, ...rest] = process.argv;
const file = ${JSON.stringify(kit.paths.claudeJson)};
const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
json.mcpServers ??= {};
if (cmd === 'add-json') json.mcpServers[rest[2]] = { type: 'stdio', ...JSON.parse(rest[3]) };
if (cmd === 'remove') delete json.mcpServers[rest[2]];
fs.writeFileSync(file, JSON.stringify(json, null, 2));
`);
  chmodSync(kit.paths.claudeBin, 0o755);
}

/** Everything Claude reads, as a path -> content map. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(kit.paths.claudeDir, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(kit.paths.claudeDir);
  return out;
}
const preview = (id: string, action: string) => ok<OsPluginPlan>('POST', `/api/os-plugins/${id}/preview`, { action });
const confirm = (id: string, action: string, sha: string) => req<OsPluginsReport>('POST', `/api/os-plugins/${id}/${action}`, { confirmed: true, sha });

describe('manifest validation', () => {
  const check = (raw: unknown, setup?: (dir: string) => void) => {
    const dir = join(kit.base, 'p', 'x');
    kit.write(join(dir, MANIFEST), typeof raw === 'string' ? raw : JSON.stringify(raw));
    setup?.(dir);
    return validateManifest('x', dir);
  };
  const good = { id: 'x', name: 'X', description: 'd', version: '1.2.3', author: 'a', contains: { hooks: [{ event: 'Stop', command: 'true' }] } };

  it('accepts a whole manifest and fills in the plugin folder', () => {
    const { manifest: m, errors } = check({ ...good, contains: { hooks: [{ event: 'Stop', command: '{pluginDir}/a' }], mcp: { s: { command: 'node', args: ['{pluginDir}/s.js'] } } } });
    assert.deepEqual(errors, []);
    assert.equal(m!.hooks[0].command, `${join(kit.base, 'p', 'x')}/a`);
    assert.deepEqual(m!.mcp.s.args, [`${join(kit.base, 'p', 'x')}/s.js`]);
  });

  it('names every problem', () => {
    const cases: [unknown, RegExp][] = [
      ['{not json', /not a JSON object/],
      [{ ...good, id: 'other' }, /id must equal/],
      [{ ...good, name: '' }, /name is required/],
      [{ ...good, description: undefined }, /description is required/],
      [{ ...good, author: 5 }, /author is required/],
      [{ ...good, version: 'latest' }, /version must look like/],
      [{ ...good, contains: undefined }, /contains is required/],
      [{ ...good, contains: {} }, /lists nothing/],
      [{ ...good, contains: { agents: ['a'] } }, /contains\.agents/],
      [{ ...good, contains: { skills: ['nope'] } }, /skills\/nope\/SKILL\.md is missing/],
      [{ ...good, contains: { skills: ['../../etc'] } }, /bad skill name/],
      [{ ...good, contains: { hooks: [{ event: 'Stop' }] } }, /bad hook/],
      [{ ...good, contains: { hooks: [{ event: 'bad event', command: 'x' }] } }, /bad hook/],
      [{ ...good, contains: { mcp: { 'a:b': { command: 'x' } } } }, /bad server name/],
      [{ ...good, contains: { mcp: { a: {} } } }, /needs a command or a url/],
    ];
    for (const [raw, expected] of cases) {
      const r = check(raw);
      assert.equal(r.manifest, null, String(expected));
      assert.match(r.errors.join('; '), expected);
    }
    assert.match(validateManifest('gone', join(kit.base, 'nowhere')).errors.join(), /no plugin\.json/);
  });

  it('contains kit without files json is an error', () => {
    assert.match(check({ ...good, contains: { kit: 'kit' } }).errors.join('; '), /contains\.kit: kit\/files\.json is missing/);
    assert.match(check({ ...good, contains: { kit: 'templates' } }).errors.join('; '), /contains\.kit must be "kit"/);
    const { manifest: m, errors } = check({ ...good, contains: { kit: 'kit' } }, (dir) => kit.write(join(dir, 'kit', 'files.json'), '[]\n'));
    assert.deepEqual(errors, []);
    assert.equal(m!.kit, 'kit');
  });

  it('an unknown component is still rejected', () => {
    const r = check({ ...good, contains: { ...good.contains, foo: ['a'] } });
    assert.equal(r.manifest, null);
    assert.deepEqual(r.errors, ['contains.foo is not a known component']);
  });

  it('refuses a symlink in the folder', () => {
    const r = check(good, (dir) => symlinkSync('/etc/passwd', join(dir, 'link')));
    assert.match(r.errors.join(), /symlinks/);
  });
});

describe('plugins over the API', () => {
  beforeEach(() => registerTools(kit.ctx));

  it('lists with validation, runs nothing, keeps a bad plugin from being enabled', async () => {
    const dir = plugin();
    plugin('bad', { version: 'x' });
    const before = snapshot();
    const r = await ok<OsPluginsReport>('GET', '/api/os-plugins');
    assert.deepEqual(r.rows.map((x) => [x.id, x.enabled, x.errors.length > 0]), [['bad', false, true], ['full', false, false]]);
    assert.deepEqual(r.rows[1].contains.skills, ['helper']);
    assert.equal(r.rows[1].contains.hooks[0].command, `bash "${dir}/run.sh"`);
    assert.doesNotMatch(JSON.stringify(r), /secret-value/);
    assert.equal((await req('POST', '/api/os-plugins/bad/preview', { action: 'enable' })).status, 422);
    assert.deepEqual(snapshot(), before);
    assert.equal(existsSync(join(dir, 'ran')), false);
  });

  it('enable changes exactly what it listed, disable puts everything back', async () => {
    fakeClaude();
    const dir = plugin();
    const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } };
    kit.write(join(kit.paths.claudeDir, 'settings.json'), JSON.stringify(original));
    kit.write(join(kit.paths.claudeDir, 'skills', 'other', 'SKILL.md'), 'other\n');
    const before = snapshot();

    const plan = await preview('full', 'enable');
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.changes.map((c) => [c.kind, c.action, c.name]), [['skill', 'add', 'helper'], ['hook', 'add', 'Stop'], ['hook', 'add', 'PostToolUse · Edit'], ['mcp', 'add', 'docs']]);
    assert.equal(plan.changes[0].where, join(kit.paths.claudeDir, 'skills', 'helper'));
    assert.equal(plan.changes[1].where, join(kit.paths.claudeDir, 'settings.json'));
    assert.equal(plan.changes[1].detail, `bash "${dir}/run.sh"`);
    assert.doesNotMatch(JSON.stringify(plan), /secret-value/);
    assert.deepEqual(snapshot(), before, 'a preview writes nothing');

    assert.equal((await req('POST', '/api/os-plugins/full/enable', { sha: plan.sha })).status, 400);
    assert.equal((await confirm('full', 'enable', 'stale')).status, 409);

    const on = await confirm('full', 'enable', plan.sha);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const row = on.body.rows.find((x) => x.id === 'full')!;
    assert.deepEqual([row.enabled, row.installedVersion, row.changed], [true, '1.0.0', false]);
    assert.ok(row.installedAt);

    const after = snapshot();
    const touched = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
    assert.deepEqual(touched, ['.claude.json', 'settings.json', 'skills/helper/SKILL.md', 'skills/helper/scripts/x.sh']);
    assert.equal(after['skills/other/SKILL.md'], 'other\n');
    const settings = JSON.parse(after['settings.json']) as typeof original & { hooks: Record<string, unknown[]> };
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.hooks.Stop, [...original.hooks.Stop, { hooks: [{ type: 'command', command: `bash "${dir}/run.sh"` }] }]);
    assert.deepEqual(settings.hooks.PostToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edited' }] }]);
    assert.deepEqual((JSON.parse(after['.claude.json']) as { mcpServers: Record<string, { args: string[] }> }).mcpServers.docs.args, [`${dir}/server.js`]);
    assert.equal(existsSync(join(dir, 'ran')), false, 'enabling runs nothing');

    // Confirming the dialog is the approval: hooks and commands are on the same list as any other approved command.
    const approved = JSON.parse(readFileSync(join(kit.paths.data, 'approved-commands.json'), 'utf8')) as string[];
    assert.ok(approved.includes(sha256(`bash "${dir}/run.sh"`)));
    assert.ok(approved.includes(sha256(`node ${dir}/server.js`)));
    assert.ok(kit.audits.some((a) => a.action === 'os-plugin.enable'));

    assert.deepEqual((await preview('full', 'enable')).conflicts.includes('the plugin is already enabled'), true);

    const off = await preview('full', 'disable');
    assert.deepEqual(off.changes.map((c) => [c.kind, c.action, c.name]), [['skill', 'remove', 'helper'], ['hook', 'remove', 'Stop'], ['hook', 'remove', 'PostToolUse · Edit'], ['mcp', 'remove', 'docs']]);
    const done = await confirm('full', 'disable', off.sha);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.rows[0].enabled, false);
    assert.equal(done.body.rows[0].installedVersion, null);

    const back = snapshot();
    assert.deepEqual(JSON.parse(back['settings.json']), original);
    assert.deepEqual((JSON.parse(back['.claude.json']) as { mcpServers: object }).mcpServers, {});
    assert.equal(back['skills/other/SKILL.md'], 'other\n');
    assert.deepEqual(Object.keys(back).sort(), ['.claude.json', 'settings.json', 'skills/other/SKILL.md']);
  });

  it('a settings file the plugin created goes away with it', async () => {
    plugin('hooky', { contains: { hooks: [{ event: 'Stop', command: 'echo hi' }] } });
    const plan = await preview('hooky', 'enable');
    assert.equal((await confirm('hooky', 'enable', plan.sha)).status, 200);
    assert.ok(existsSync(join(kit.paths.claudeDir, 'settings.json')));
    const off = await preview('hooky', 'disable');
    assert.equal((await confirm('hooky', 'disable', off.sha)).status, 200);
    assert.equal(existsSync(join(kit.paths.claudeDir, 'settings.json')), false);
  });

  it('what the user changed after enabling stays, and the plan says so', async () => {
    plugin('sk', { contains: { skills: ['helper'], hooks: [{ event: 'Stop', command: 'echo hi' }] } });
    const plan = await preview('sk', 'enable');
    assert.equal((await confirm('sk', 'enable', plan.sha)).status, 200);
    const skillFile = join(kit.paths.claudeDir, 'skills', 'helper', 'SKILL.md');
    kit.write(skillFile, 'my edits\n');
    kit.write(join(kit.paths.claudeDir, 'settings.json'), '{}');
    const off = await preview('sk', 'disable');
    assert.deepEqual(off.changes.map((c) => [c.kind, c.action]), [['skill', 'keep'], ['hook', 'gone']]);
    assert.equal((await confirm('sk', 'disable', off.sha)).status, 200);
    assert.equal(readFileSync(skillFile, 'utf8'), 'my edits\n');
  });

  it('a conflict blocks enabling; a changed folder needs a new review; a failed step is rolled back', async () => {
    fakeClaude();
    plugin();
    const skill = join(kit.paths.claudeDir, 'skills', 'helper', 'SKILL.md');
    kit.write(skill, 'mine\n');
    const blocked = await preview('full', 'enable');
    assert.match(blocked.conflicts.join(), /skill helper already exists/);
    assert.equal((await confirm('full', 'enable', blocked.sha)).status, 409);
    assert.equal(readFileSync(skill, 'utf8'), 'mine\n');
    rmSync(join(kit.paths.claudeDir, 'skills', 'helper'), { recursive: true });

    const plan = await preview('full', 'enable');
    kit.write(join(kit.paths.config, 'plugins', 'full', 'run.sh'), 'echo swapped\n');
    assert.equal((await confirm('full', 'enable', plan.sha)).status, 409);

    const before = snapshot();
    kit.write(kit.paths.claudeBin, '#!/bin/bash\nexit 1\n');
    chmodSync(kit.paths.claudeBin, 0o755);
    const fresh = await preview('full', 'enable');
    assert.equal((await confirm('full', 'enable', fresh.sha)).status, 422);
    assert.deepEqual(snapshot(), before);
    assert.equal((await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows[0].enabled, false);
  });

  it('a plugin whose folder is gone can still be disabled', async () => {
    plugin('hooky', { contains: { hooks: [{ event: 'Stop', command: 'echo hi' }] } });
    const plan = await preview('hooky', 'enable');
    assert.equal((await confirm('hooky', 'enable', plan.sha)).status, 200);
    rmSync(join(kit.paths.config, 'plugins', 'hooky'), { recursive: true });
    const r = await ok<OsPluginsReport>('GET', '/api/os-plugins');
    assert.deepEqual([r.rows[0].id, r.rows[0].enabled, r.rows[0].errors], ['hooky', true, ['the plugin folder is gone']]);
    const off = await preview('hooky', 'disable');
    assert.equal((await confirm('hooky', 'disable', off.sha)).status, 200);
    assert.deepEqual((await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows, []);
  });

  it('empty folders list nothing, a local plugin is listed and not enabled', async () => {
    assert.deepEqual((await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows, []);
    plugin();
    const r = await ok<OsPluginsReport>('GET', '/api/os-plugins');
    assert.deepEqual(r.rows.map((x) => [x.id, x.enabled]), [['full', false]]);
    assert.equal('samples' in r, false);
    assert.equal(existsSync(join(kit.paths.claudeDir, 'skills', 'helper')), false);
  });

  describe('shipped and user plugins', () => {
    const uiPlugin = (base: string, id = 'p') => {
      const dir = join(base, id);
      kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id, contains: { ui: { entry: 'ui/index.js' } } })));
      kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => ({});\n');
      return dir;
    };
    const userDir = () => join(kit.paths.config, 'plugins');
    const enable = async (id: string) => ok('POST', `/api/os-plugins/${id}/enable`, { confirmed: true, sha: (await preview(id, 'enable')).sha });
    const rows = async () => (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;

    it('lists shipped plugins', async () => {
      const dir = uiPlugin(kit.paths.plugins);
      const r = await rows();
      assert.deepEqual(r.map((x) => [x.id, x.source, x.path, x.enabled]), [['p', 'shipped', dir, false]]);
    });

    it('user copy shadows a changed shipped plugin', async () => {
      const shipped = uiPlugin(kit.paths.plugins);
      const user = uiPlugin(userDir());
      await enable('p');
      kit.write(join(shipped, 'ui', 'index.js'), 'export const activate = () => ({ changed: true });\n');
      const [row] = await rows();
      assert.deepEqual([row.source, row.path, row.enabled, row.changed], ['user', user, true, false]);
      const [ui] = await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui');
      assert.doesNotMatch((await kit.app.inject({ url: ui.url })).body, /changed/);
    });

    it('state survives moving a plugin from user to shipped', async () => {
      const user = uiPlugin(userDir());
      await enable('p');
      mkdirSync(kit.paths.plugins, { recursive: true });
      renameSync(user, join(kit.paths.plugins, 'p'));
      const [row] = await rows();
      assert.deepEqual([row.source, row.enabled, row.changed, row.errors], ['shipped', true, false, []]);
      const [ui] = await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui');
      assert.equal(ui.id, 'p');
      assert.equal((await kit.app.inject({ url: ui.url })).statusCode, 200);
    });

    it('a shipped plugin changed by an update stops running until it is reviewed again', async () => {
      const shipped = uiPlugin(kit.paths.plugins);
      await enable('p');
      assert.equal((await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui')).length, 1);
      kit.write(join(shipped, 'ui', 'index.js'), 'export const activate = () => ({ updated: true });\n');
      const [row] = await rows();
      assert.deepEqual([row.source, row.enabled, row.changed], ['shipped', true, true]);
      assert.deepEqual(await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui'), []);
    });

    it('the disable plan names the folder the interface code runs from', async () => {
      const shipped = uiPlugin(kit.paths.plugins);
      await enable('p');
      const plan = await preview('p', 'disable');
      assert.deepEqual(plan.changes.filter((c) => c.kind === 'ui').map((c) => c.where), [shipped]);
    });
  });

  describe('icon, description, features', () => {
    it('come through the row, the icon drawn from the library', async () => {
      plugin('nice', { icon: 'map', descriptionRu: 'Описание', features: ['One'], featuresRu: ['Раз'] });
      const [row] = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;
      assert.equal(row.descriptionRu, 'Описание');
      assert.deepEqual([row.features, row.featuresRu], [['One'], ['Раз']]);
      assert.match(row.icon!, /^<svg /);
      plugin('plain');
      const plain = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows.find((x) => x.id === 'plain')!;
      assert.deepEqual([plain.icon, plain.descriptionRu, plain.features], [null, null, []]);
    });
    it('an unknown icon or a bad list is a manifest error', () => {
      const dir = plugin('bad', { icon: 'no-such-icon-at-all', features: 'text' });
      assert.match(validateManifest('bad', dir).errors.join(';'), /icon no-such-icon-at-all is not in the libraries.*features must be a list/);
    });
  });

  describe('dependencies', () => {
    const BLOCK = 'Use the skill.';
    const configDep = { id: 'md', kind: 'config', file: 'claude-md', block: 'block.md', title: 'Lines', titleRu: 'Строки', why: 'Needed', whyRu: 'Нужно' };
    const withDeps = (id: string, dependencies: unknown[]) => {
      const dir = plugin(id, { dependencies, contains: { skills: ['helper'] } });
      kit.write(join(dir, 'block.md'), `${BLOCK}\n`);
      return dir;
    };
    const claudeMd = () => join(kit.paths.claudeDir, 'CLAUDE.md');
    const fence = (id: string, body = BLOCK) => `<!-- os-plugin:${id}:md:start -->\n${body}\n<!-- os-plugin:${id}:md:end -->`;
    const on = async (id: string) => {
      const plan = await preview(id, 'enable');
      const r = await confirm(id, 'enable', plan.sha);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };

    it('a bad declaration names what is wrong', () => {
      const cases: [unknown, RegExp][] = [
        ['x', /dependencies must be a list/],
        [[{ kind: 'config' }], /needs an id/],
        [[{ id: 'a', kind: 'magic', title: 't', why: 'w' }], /kind can only be config, service, package, download/],
        [[{ id: 'a', kind: 'package', bin: 'x', why: 'w', task: 't' }], /needs a title and why/],
        [[{ id: 'a', kind: 'package', bin: 'x y', title: 't', why: 'w', task: 't' }], /needs a bin/],
        [[{ id: 'a', kind: 'package', bin: 'x', title: 't', why: 'w' }], /needs a task/],
        [[{ id: 'a', kind: 'service', url: 'ftp://x', title: 't', why: 'w', task: 't' }], /needs a url/],
        [[{ id: 'a', kind: 'download', path: '{pluginDir}/x', title: 't', why: 'w', task: 't' }], /needs a path/],
        [[{ id: 'a', kind: 'download', path: '{claudeDir}/../x', title: 't', why: 'w', task: 't' }], /needs a path/],
        [[{ id: 'a', kind: 'config', file: 'settings', block: 'b.md', title: 't', why: 'w' }], /file can only be claude-md/],
        [[{ id: 'a', kind: 'config', file: 'claude-md', block: '../b.md', title: 't', why: 'w' }], /block must be a file/],
        [[{ id: 'a', kind: 'config', file: 'claude-md', block: 'none.md', title: 't', why: 'w' }], /none\.md is missing/],
        [[{ id: 'a', kind: 'package', bin: 'x', title: 't', why: 'w', task: 't' }, { id: 'a', kind: 'package', bin: 'x', title: 't', why: 'w', task: 't' }], /used twice/],
        [[{ id: 'a', kind: 'package', bin: 'x', level: 'maybe', title: 't', why: 'w', task: 't' }], /level can only be/],
      ];
      for (const [dependencies, expected] of cases) {
        const dir = plugin('d', { dependencies });
        assert.match(validateManifest('d', dir).errors.join(';'), expected);
      }
    });

    it('the plan shows them with their state and the request to Claude; enabling is not held back and writes no block', async () => {
      withDeps('dep', [
        configDep,
        { id: 'tool', kind: 'package', bin: 'no-such-program-here', title: 'Tool', why: 'Runs it', task: 'Install the tool.' },
        { id: 'node', kind: 'package', bin: 'node', title: 'Node', why: 'Runs it', task: 'Install node.' },
        { id: 'far', kind: 'service', url: 'https://example.invalid/x', level: 'recommended', title: 'Far', why: 'Calls it', task: 'Sign up.' },
        { id: 'model', kind: 'download', path: '{pluginData}/model.bin', title: 'Model', why: 'Reads it', task: 'Download the model.' },
      ]);
      const plan = await preview('dep', 'enable');
      assert.deepEqual(plan.dependencies.map((d) => [d.id, d.kind, d.level, d.state]), [
        ['md', 'config', 'required', 'missing'],
        ['tool', 'package', 'required', 'missing'],
        ['node', 'package', 'required', 'met'],
        ['far', 'service', 'recommended', 'unknown'],
        ['model', 'download', 'required', 'missing'],
      ]);
      assert.equal(plan.dependencies[0].target, claudeMd());
      assert.equal(plan.dependencies[0].block, fence('dep'));
      assert.equal(plan.dependencies[4].target, join(kit.paths.data, 'os-plugin-data', 'dep', 'model.bin'));
      assert.match(plan.setup!.prompt, /choose where the block fits best/);
      assert.ok(plan.setup!.prompt.includes(fence('dep')));
      assert.match(plan.setup!.prompt, /Install the tool\./);
      assert.doesNotMatch(plan.setup!.prompt, /Install node\.|Sign up\./, 'what is there or cannot be known is not asked for');
      assert.deepEqual(plan.conflicts, []);
      assert.equal((await confirm('dep', 'enable', plan.sha)).status, 200);
      assert.equal(existsSync(claudeMd()), false, 'the server never writes the block: Claude chooses the place');
    });

    it('plugin setup tab opens in the root folder', async () => {
      withDeps('dep', [configDep]);
      assert.equal((await preview('dep', 'enable')).setup!.cwd, kit.paths.root);
    });

    it('asks a service on this machine only, and reads its answer', async () => {
      const server = createServer((q, res) => res.writeHead(q.url === '/health' ? 200 : 500).end());
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as AddressInfo;
      try {
        withDeps('svc', [
          { id: 'up', kind: 'service', url: `http://127.0.0.1:${port}/health`, title: 'Up', why: 'w', task: 't' },
          { id: 'sick', kind: 'service', url: `http://127.0.0.1:${port}/sick`, title: 'Sick', why: 'w', task: 't' },
        ]);
        const [row] = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;
        assert.deepEqual(row.dependencies.map((d) => d.state), ['met', 'missing']);
      } finally {
        server.close();
      }
    });

    it('Claude puts the block anywhere: it counts as met, and disabling takes exactly it away', async () => {
      withDeps('dep', [configDep]);
      await on('dep');
      assert.equal((await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows[0].setup?.title, 'Full: setup');
      kit.write(claudeMd(), `# Mine\n\nkeep me\n\n${fence('dep')}\n\n## Later\n\nkeep me too\n`);
      const [row] = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;
      assert.equal(row.dependencies[0].state, 'met');
      assert.equal(row.setup, null);

      const off = await preview('dep', 'disable');
      assert.deepEqual(off.changes.find((c) => c.kind === 'config'), { kind: 'config', action: 'remove', name: 'Lines', where: claudeMd(), detail: '' });
      assert.equal((await confirm('dep', 'disable', off.sha)).status, 200);
      assert.equal(readFileSync(claudeMd(), 'utf8'), '# Mine\n\nkeep me\n\n## Later\n\nkeep me too\n');
    });

    it('the block leaves nothing behind at the top of the file, at its end or alone in it', async () => {
      withDeps('dep', [configDep]);
      for (const [before, after] of [
        [`${fence('dep')}\n\n# Mine\n`, '# Mine\n'],
        [`# Mine\n\n${fence('dep')}`, '# Mine\n'],
        [`${fence('dep')}\n`, ''],
      ]) {
        await on('dep');
        kit.write(claudeMd(), before);
        assert.equal((await confirm('dep', 'disable', (await preview('dep', 'disable')).sha)).status, 200);
        assert.equal(readFileSync(claudeMd(), 'utf8'), after);
      }
    });

    it('a block edited by hand stays where it is, and the plan says so', async () => {
      withDeps('dep', [configDep]);
      await on('dep');
      const text = `${fence('dep', 'My own words.')}\n`;
      kit.write(claudeMd(), text);
      const off = await preview('dep', 'disable');
      assert.equal(off.changes.find((c) => c.kind === 'config')?.action, 'keep');
      assert.equal((await confirm('dep', 'disable', off.sha)).status, 200);
      assert.equal(readFileSync(claudeMd(), 'utf8'), text);
    });
  });

  describe('update', () => {
    it('replaces what was installed with the folder as it is now, and starts running it again', async () => {
      fakeClaude();
      const dir = plugin('upd', { version: '1.0.0', contains: { skills: ['helper'], ui: { entry: 'ui/index.js' } } });
      kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => ({});\n');
      await ok('POST', '/api/os-plugins/upd/enable', { confirmed: true, sha: (await preview('upd', 'enable')).sha });
      assert.equal((await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui')).length, 1);
      assert.equal((await req('POST', '/api/os-plugins/upd/preview', { action: 'update' })).status, 200);

      kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id: 'upd', version: '1.1.0', contains: { skills: ['helper'], ui: { entry: 'ui/index.js' } } })));
      kit.write(join(dir, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: Helps more\n---\nnew body\n');
      assert.deepEqual(await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui'), [], 'a changed folder stops counting');
      const [changed] = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;
      assert.deepEqual([changed.changed, changed.installedVersion, changed.version], [true, '1.0.0', '1.1.0']);

      const plan = await preview('upd', 'update');
      assert.deepEqual([plan.action, plan.conflicts], ['update', []]);
      assert.equal((await req('POST', '/api/os-plugins/upd/update', { confirmed: true, sha: 'stale' })).status, 409);
      const after = (await confirm('upd', 'update', plan.sha)).body;
      assert.deepEqual([after.rows[0].changed, after.rows[0].installedVersion], [false, '1.1.0']);
      assert.match(readFileSync(join(kit.paths.claudeDir, 'skills', 'helper', 'SKILL.md'), 'utf8'), /new body/);
      assert.equal((await ok<OsPluginUi[]>('GET', '/api/os-plugins/ui')).length, 1);
    });

    it('a skill changed by hand is a conflict, and it is left alone', async () => {
      const dir = plugin('upd', { contains: { skills: ['helper'] } });
      await ok('POST', '/api/os-plugins/upd/enable', { confirmed: true, sha: (await preview('upd', 'enable')).sha });
      const mine = join(kit.paths.claudeDir, 'skills', 'helper', 'SKILL.md');
      kit.write(mine, '---\nname: helper\ndescription: Mine\n---\nmine\n');
      kit.write(join(dir, 'run.sh'), 'echo new\n');
      const plan = await preview('upd', 'update');
      assert.match(plan.conflicts.join(), /skill helper already exists/);
      assert.equal((await confirm('upd', 'update', plan.sha)).status, 409);
      assert.match(readFileSync(mine, 'utf8'), /mine/);
    });

    it('needs the plugin to be enabled', async () => {
      plugin('upd');
      assert.equal((await req('POST', '/api/os-plugins/upd/preview', { action: 'update' })).status, 409);
      assert.equal((await req('POST', '/api/os-plugins/upd/update', { confirmed: true, sha: 'x' })).status, 409);
    });
  });

  describe('media route', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    it('needs its permission; the bytes decide the type, a range is honoured', async () => {
      const cwd = join(kit.base, 'proj');
      kit.write(join(cwd, 'secret.mp4'), 'API_KEY=secret');
      writeFileSync(join(cwd, 'a.png'), PNG);
      writeFileSync(join(cwd, 'tone.wav'), Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(100, 7)]));
      const dir = join(kit.paths.config, 'plugins', 'face');
      kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id: 'face', contains: { ui: { entry: 'ui/index.js', permissions: ['files.media'] } } })));
      kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => ({});\n');
      const id = 'tab1';
      (kit.ctx as unknown as { chat: unknown }).chat = { tabInfo: () => ({ cwd, project: null, kind: 'work' }) };
      const get = (path: string, range?: string) => kit.app.inject({ url: `/api/tabs/${id}/media?path=${encodeURIComponent(path)}`, headers: range ? { range } : {} });
      assert.equal((await get('a.png')).statusCode, 403);

      await ok('POST', '/api/os-plugins/face/enable', { confirmed: true, sha: (await preview('face', 'enable')).sha });
      const image = await get('a.png');
      assert.deepEqual([image.statusCode, image.headers['content-type'], image.headers['x-content-type-options']], [200, 'image/png', 'nosniff']);
      assert.equal((await get('secret.mp4')).statusCode, 415, 'the name does not make it a video');
      const part = await get('tone.wav', 'bytes=4-13');
      assert.deepEqual([part.statusCode, part.headers['content-range'], part.headers['content-length'], part.headers['content-type']], [206, 'bytes 4-13/112', '10', 'audio/wav']);
      assert.equal(part.rawPayload.length, 10);
      assert.equal((await get('tone.wav', 'bytes=-12')).headers['content-range'], 'bytes 100-111/112');
      assert.equal((await get('tone.wav', 'bytes=500-')).statusCode, 416);
      assert.equal((await get('../outside.png')).statusCode >= 400, true);
    });
    it('knows the common formats by their first bytes', () => {
      const of = (...b: (number | string)[]) => mediaType(Buffer.concat(b.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from([x])))));
      assert.equal(of('\0\0\0\x18ftypisom'), 'video/mp4');
      assert.equal(of('\0\0\0\x18ftypM4A '), 'audio/mp4');
      assert.equal(of('\0\0\0\x18ftypqt  '), 'video/quicktime');
      assert.equal(of(0x1a, 0x45, 0xdf, 0xa3), 'video/webm');
      assert.equal(of('OggS'), 'audio/ogg');
      assert.equal(of('fLaC'), 'audio/flac');
      assert.equal(of('ID3\x03'), 'audio/mpeg');
      assert.equal(of(0xff, 0xfb, 0x90), 'audio/mpeg');
      assert.equal(of(0xff, 0xf1), 'audio/aac');
      assert.equal(of(0, 0, 1, 0), 'image/x-icon');
      assert.equal(of('hello world'), null);
    });
  });

  describe('interface code', () => {
    const uiPlugin = (permissions: string[] = ['files.write']) => {
      const dir = join(kit.paths.config, 'plugins', 'face');
      kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id: 'face', contains: { ui: { entry: 'ui/index.js', permissions } } })));
      kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => ({});\n');
      kit.write(join(dir, 'ui', 'part.js'), 'export const part = 1;\n');
      kit.write(join(dir, 'secret.js'), 'export const secret = 1;\n');
      return dir;
    };
    const toggle = async (action: 'enable' | 'disable') => {
      const plan = await ok<OsPluginPlan>('POST', '/api/os-plugins/face/preview', { action });
      await ok('POST', `/api/os-plugins/face/${action}`, { confirmed: true, sha: plan.sha });
      return plan;
    };
    const list = () => ok<OsPluginUi[]>('GET', '/api/os-plugins/ui');
    const write = () => req('PUT', '/api/tabs/nope/file', { path: 'x', text: '', sha: '' });
    const status = async (url: string) => (await kit.app.inject({ url })).statusCode;

    it('is served and holds its permissions only while enabled, and changes nothing in Claude', async () => {
      uiPlugin();
      const before = snapshot();
      assert.deepEqual(await list(), []);
      assert.equal((await write()).status, 403);

      const plan = await toggle('enable');
      assert.deepEqual(plan.changes.map((c) => [c.kind, c.action, c.detail]), [['ui', 'add', 'ui/index.js; files.write']]);
      assert.deepEqual(snapshot(), before);
      const [ui] = await list();
      assert.deepEqual([ui.id, ui.name], ['face', 'Full']);
      const res = await kit.app.inject({ url: ui.url });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /javascript/);
      assert.equal(await status(ui.url.replace('index.js', 'part.js')), 200);
      assert.notEqual(await status(ui.url.replace('ui/index.js', 'secret.js')), 200);
      assert.equal(await status(ui.url.replace('index.js', '..%2F..%2Fsecret.js')), 404);
      assert.equal(await status(ui.url.replace('index.js', 'missing.js')), 404);
      // Past the permission check: the fake tab is what stops it now.
      assert.notEqual((await write()).status, 403);
      assert.equal((await req('POST', '/api/tabs/nope/reveal', { path: 'x' })).status, 403, 'files.reveal was not asked for');

      await toggle('disable');
      assert.deepEqual(await list(), []);
      assert.equal(await status(ui.url), 404);
      assert.equal((await write()).status, 403);
    });

    it('changed after enabling, it stops running until it is reviewed again', async () => {
      const dir = uiPlugin();
      await toggle('enable');
      const [ui] = await list();
      kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => { steal(); };\n');
      assert.deepEqual(await list(), []);
      assert.equal(await status(ui.url), 404);
      assert.equal((await write()).status, 403);
      assert.equal((await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows[0].changed, true);

      await toggle('disable');
      await toggle('enable');
      const [again] = await list();
      assert.notEqual(again.url, ui.url);
      assert.match((await kit.app.inject({ url: again.url })).body, /steal/);
    });

    it('a bad entry or an unknown permission is refused', () => {
      const dir = uiPlugin();
      const errors = (ui: unknown) => {
        kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id: 'face', contains: { ui } })));
        return validateManifest('face', dir).errors;
      };
      assert.deepEqual(errors({ entry: '../secret.js' }), ['contains.ui.entry must be a .js file under ui/']);
      assert.deepEqual(errors({ entry: 'ui/../secret.js' }), ['contains.ui.entry must be a .js file under ui/']);
      assert.deepEqual(errors({ entry: 'ui/none.js' }), ['contains.ui.entry: ui/none.js is missing']);
      assert.match(errors({ entry: 'ui/index.js', permissions: ['shell.run'] })[0], /permissions can only list/);
      assert.deepEqual(errors({ entry: 'ui/index.js' }), []);
    });

    it('the file manager gets the right command on each system', () => {
      assert.deepEqual(revealArgv('windows', 'C:\\a b\\c.txt', false), { bin: 'explorer.exe', args: ['/select,C:\\a b\\c.txt'] });
      assert.deepEqual(revealArgv('windows', 'C:\\a b', true), { bin: 'explorer.exe', args: ['C:\\a b'] });
      assert.deepEqual(revealArgv('mac', '/a b/c.txt', false), { bin: 'open', args: ['-R', '/a b/c.txt'] });
      assert.deepEqual(revealArgv('linux', '/a b/c.txt', false), { bin: 'xdg-open', args: ['/a b'] });
      assert.deepEqual(revealArgv('linux', '/a b', true), { bin: 'xdg-open', args: ['/a b'] });
    });
  });

  it('project icons: a chosen library icon is served as a sanitizer-valid SVG and wins over a custom one', async () => {
    kit.addProject('alpha', join(kit.base, 'alpha'));
    const dir = join(kit.paths.config, 'project-icons');
    kit.write(join(dir, 'alpha.svg'), '<svg viewBox="0 0 24 24"><rect width="1" height="1"/></svg>');
    assert.match((await ok<ProjectIcons>('GET', '/api/project-icons')).icons.alpha, /<rect/);

    const picked = await ok<ProjectIcons>('PUT', '/api/project-icons/alpha', { icon: 'map' });
    assert.equal(picked.chosen.alpha, 'map');
    assert.match(picked.icons.alpha, /stroke="#e4e4e7"/);
    const again = sanitizeSvg(picked.icons.alpha);
    assert.ok(again.ok && again.svg === picked.icons.alpha);

    const logo = await ok<ProjectIcons>('PUT', '/api/project-icons/alpha', { icon: 'si:gitlab' });
    assert.match(logo.icons.alpha, new RegExp(`fill="${LIBRARY_ICON_INK}"`));

    assert.equal((await req('PUT', '/api/project-icons/alpha', { icon: 'no-such-icon' })).status, 400);
    assert.equal((await req('PUT', '/api/project-icons/alpha', { icon: '../../secret' })).status, 400);
    assert.equal((await req('PUT', '/api/project-icons/nobody', { icon: 'map' })).status, 404);

    const reset = await ok<ProjectIcons>('PUT', '/api/project-icons/alpha', { icon: null });
    assert.deepEqual(reset.chosen, {});
    assert.match(reset.icons.alpha, /<rect/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'icons.json'), 'utf8')), {});
    assert.ok(existsSync(join(dir, 'alpha.svg')), 'the custom file stays');
  });

  it('project icons: names Claude wrote are read, an unknown one is reported; the library is searchable', async () => {
    kit.write(join(kit.paths.config, 'project-icons', 'icons.json'), JSON.stringify({ a: 'brain', b: 'not-an-icon', c: 5 }));
    const icons = await ok<ProjectIcons>('GET', '/api/project-icons');
    assert.deepEqual(icons.chosen, { a: 'brain' });
    assert.deepEqual(icons.rejected.map((r) => r.key).sort(), ['b', 'c']);
    const first = await ok<IconLibrary>('GET', '/api/project-icons/library');
    assert.ok(first.items.length > 40);
    const found = await ok<IconLibrary>('GET', '/api/project-icons/library?q=gitlab');
    assert.deepEqual(found.items.map((i) => i.name), ['si:gitlab']);
    assert.deepEqual((await ok<IconLibrary>('GET', '/api/project-icons/library?q=zzzzzz')).items, []);
  });
});

describe('kit component', () => {
  it('a kit component validates and installs nothing globally', async () => {
    const osPlugins = createOsPlugins(kit.ctx, createSkills(kit.ctx), createMcp(kit.ctx), createApprovals(kit.ctx));
    const dir = join(kit.paths.plugins, 'kitted');
    kit.write(join(dir, MANIFEST), JSON.stringify(manifest({ id: 'kitted', contains: { kit: 'kit' } })));
    kit.write(join(dir, 'kit', 'files.json'), '[]\n');
    const data = () => readdirSync(kit.paths.data).filter((n) => n !== 'os-plugins.json');
    const before = [snapshot(), data()];
    const plan = await preview('kitted', 'enable');
    assert.deepEqual(plan.changes.map((c) => [c.kind, c.action, c.name, c.where, c.detail]), [['kit', 'add', 'Full', dir, 'project kit actions']]);
    assert.equal(osPlugins.activeKit(), null);
    assert.equal((await confirm('kitted', 'enable', plan.sha)).status, 200);
    assert.deepEqual([snapshot(), data()], before);
    assert.deepEqual(osPlugins.activeKit(), { id: 'kitted', dir: join(dir, 'kit'), version: '1.0.0' });
    const [row] = (await ok<OsPluginsReport>('GET', '/api/os-plugins')).rows;
    assert.deepEqual([row.contains.kit, row.changed], ['kit', false]);

    kit.write(join(dir, 'kit', 'x.md'), '# x\n');
    kit.write(join(dir, 'kit', 'files.json'), '[{ "path": "x.md", "owner": "kit" }]\n');
    assert.equal(osPlugins.activeKit(), null);
    const update = await preview('kitted', 'update');
    assert.equal((await confirm('kitted', 'update', update.sha)).status, 200);
    assert.equal(osPlugins.activeKit()?.id, 'kitted');
    assert.deepEqual([snapshot(), data()], before);
  });
});

describe('shipped plugins and content', () => {
  const SHIPPED = join(REPO, 'plugins');
  it('the shipped plugins are valid, with an icon and a version', () => {
    for (const id of ['rg-context', 'ide-plus', 'agentation', 'os-builder']) {
      const { errors, manifest: m } = validateManifest(id, join(SHIPPED, id));
      assert.deepEqual(errors, [], id);
      assert.ok(m?.icon && m.descriptionRu && m.features.length && m.featuresRu.length === m.features.length, id);
    }
    assert.deepEqual(validateManifest('rg-context', join(SHIPPED, 'rg-context')).manifest?.dependencies.map((d) => [d.id, d.kind]), [['claude-md', 'config'], ['ripgrep', 'package']]);
  });

  it('every icon the app offers exists in the libraries', async () => {
    const source = readFileSync(join(REPO, 'server', 'tools', 'projectIcons.ts'), 'utf8');
    const starter = /const STARTER = \[([^\]]+)\]/.exec(source)![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1));
    for (const name of starter) assert.ok(await renderLibraryIcon(name), name);
  });

  const hasRg = spawnSync('rg', ['--version']).status === 0;
  it('rgc ranks files, finds definitions, keeps to the budget', { skip: !hasRg }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgc-'));
    try {
      const script = join(SHIPPED, 'rg-context', 'skills', 'rg-context', 'rgc.sh');
      const run = (...args: string[]) => spawnSync('bash', [script, ...args], { cwd: dir, encoding: 'utf8' });
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'tests'));
      mkdirSync(join(dir, 'node_modules'));
      const w = (path: string, text: string) => execFileSync('bash', ['-c', 'printf "%s" "$1" > "$2"', '_', text, join(dir, path)]);
      w('src/low.ts', 'retryLimit\n');
      w('src/main.ts', 'export function retryLimit() {}\nretryLimit()\nretryLimit()\n');
      w('tests/main.test.ts', 'retryLimit()\n');
      w('node_modules/skip.js', 'retryLimit retryLimit retryLimit retryLimit\n');
      w('package-lock.json', 'retryLimit retryLimit retryLimit retryLimit\n');
      w('src/many.ts', Array.from({ length: 200 }, (_, i) => `const a${i} = 'needle';`).join('\n'));

      const out = run('retrylimit');
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /^5 matches in 3 files/);
      assert.doesNotMatch(out.stdout, /node_modules|package-lock/);
      const lines = out.stdout.split('\n');
      assert.match(lines[1], /3 {2}.*src\/main\.ts/);
      assert.match(lines[2], /1 {2}.*src\/low\.ts/, 'source before tests at the same count');
      assert.match(lines[3], /1 {2}.*tests\/main\.test\.ts/);
      assert.match(out.stdout, /== \.\/src\/main\.ts|== src\/main\.ts/);

      const def = run('--def', 'retryLimit');
      assert.match(def.stdout, /^1 matches in 1 files/);
      assert.match(def.stdout, /export function retryLimit/);

      const big = run('--budget', '20', 'needle');
      assert.ok(big.stdout.split('\n').length < 40);

      assert.equal(run('nothing-like-this').status, 1);
      assert.equal(run().status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
