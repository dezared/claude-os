import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ActionDef, McpServer, SettingsView, Skill, WidgetDef, WidgetValue } from '../../shared/contract.ts';
import { registerMemory } from '../memory/index.ts';
import { makeKit, until, type TestKit } from '../memory/testkit.ts';
import { sha256 } from '../memory/util.ts';
import { parseHealth, publicServer, redactArgs, redactUrl } from './mcp.ts';
import { registerTools } from './index.ts';
import { readFileWidget } from './widgets.ts';

const SECRET = 'SUPERSECRETVALUE1234567890abcdefghijkl';
let kit: TestKit;
let savedPath: string | undefined;

beforeEach(() => {
  kit = makeKit();
  savedPath = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await kit.close();
});

async function req<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await kit.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as T, text: res.body };
}

// A fake executable that records its argv, one JSON array per line.
function fakeBin(path: string, log: string, extra = '') {
  kit.write(path, `#!/bin/bash\nnode -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> "${log}"\n${extra}\n`);
  chmodSync(path, 0o755);
}
function fakeClaude(extra = '') {
  const log = join(kit.base, 'claude.log');
  fakeBin(kit.paths.claudeBin, log, extra);
  return log;
}
const logLines = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

function writeConfig(name: string, value: unknown) {
  kit.write(join(kit.paths.config, name), JSON.stringify(value));
}
function register() {
  registerMemory(kit.ctx);
  registerTools(kit.ctx);
}

// ---------- skills ----------

const skillMd = (d: string) => `---\nname: s\ndescription: ${d}\n---\nbody\n`;

test('skills: user, project, plugin, usage and frontmatter', async () => {
  const skills = join(kit.paths.claudeDir, 'skills');
  kit.write(join(skills, 'mine', 'SKILL.md'), skillMd('моё'));
  kit.write(join(skills, '.trash', 'old', 'SKILL.md'), skillMd('x'));
  kit.write(join(skills, 'synced', 'bucket', 'docx', 'SKILL.md'), skillMd('синхр'));
  const root = join(kit.base, 'pr');
  kit.addProject('pr', root);
  kit.write(join(root, '.claude/skills/local/SKILL.md'), skillMd('проектный'));
  const install = join(kit.paths.claudeDir, 'plugins/cache/m/plug/1.0');
  kit.write(join(install, 'skills/use-me/SKILL.md'), '---\nname: use-me\ndescription: плагинный\n---\n');
  const rootSkill = join(kit.paths.claudeDir, 'plugins/cache/m/hum/1.0');
  kit.write(join(rootSkill, 'SKILL.md'), '---\nname: hum\ndescription: в корне\n---\n');
  kit.write(join(kit.paths.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'plug@m': [{ scope: 'user', installPath: install }, { scope: 'project', projectPath: root, installPath: install }],
      'hum@m': [{ scope: 'user', installPath: rootSkill }],
    },
  }));
  kit.write(kit.paths.claudeJson, JSON.stringify({ skillUsage: { mine: { usageCount: 7, lastUsedAt: 123 }, 'plug:use-me': { usageCount: 2, lastUsedAt: 9 } } }));
  register();

  const { body } = await req<Skill[]>('GET', '/api/skills');
  const byId = new Map(body.map((s) => [s.id, s]));
  assert.deepEqual([...byId.keys()].sort(), ['plugin:anthropic-skills:docx', 'plugin:hum:hum', 'plugin:plug:use-me', 'project:pr:local', 'user:mine']);
  assert.equal(byId.get('user:mine')!.usageCount, 7);
  assert.equal(byId.get('user:mine')!.description, 'моё');
  assert.equal(byId.get('plugin:plug:use-me')!.readOnly, true);
  assert.equal(byId.get('plugin:plug:use-me')!.usageCount, 2);
  assert.equal(byId.get('project:pr:local')!.readOnly, false);
  assert.equal(byId.get('project:pr:local')!.source, 'pr');

  const put = await req('PUT', '/api/skills/plugin:plug:use-me', { content: 'x' });
  assert.equal(put.status, 403);
  assert.equal((await req('POST', '/api/skills/plugin:plug:use-me/toggle')).status, 403);
});

test('skill write through a symlink keeps the link and changes the target', async () => {
  const skills = join(kit.paths.claudeDir, 'skills');
  mkdirSync(skills, { recursive: true });
  const target = join(kit.base, 'shared-skills', 'linked');
  kit.write(join(target, 'SKILL.md'), skillMd('old'));
  symlinkSync(target, join(skills, 'linked'));
  const fileTarget = kit.write(join(kit.base, 'shared-skills', 'file-target.md'), skillMd('file'));
  mkdirSync(join(skills, 'filelink'), { recursive: true });
  symlinkSync(fileTarget, join(skills, 'filelink', 'SKILL.md'));
  register();

  const { body: list } = await req<Skill[]>('GET', '/api/skills');
  assert.equal(list.find((s) => s.id === 'user:linked')!.isSymlink, true);
  assert.equal(list.find((s) => s.id === 'user:filelink')!.isSymlink, true);

  const put = await req<Skill>('PUT', '/api/skills/user:linked', { content: skillMd('new') });
  assert.equal(put.status, 200);
  assert.ok(lstatSync(join(skills, 'linked')).isSymbolicLink());
  assert.equal(readlinkSync(join(skills, 'linked')), target);
  assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /new/);

  await req('PUT', '/api/skills/user:filelink', { content: skillMd('file2') });
  assert.ok(lstatSync(join(skills, 'filelink', 'SKILL.md')).isSymbolicLink());
  assert.match(readFileSync(fileTarget, 'utf8'), /file2/);
  assert.ok(existsSync(join(kit.paths.data, 'backups')));
  assert.ok(kit.audits.some((a) => a.action === 'skill.update' && a.target === join(target, 'SKILL.md') && a.diff?.includes('+description: new')));

  const off = await req<Skill>('POST', '/api/skills/user:linked/toggle');
  assert.equal(off.body.disabled, true);
  assert.ok(lstatSync(join(kit.paths.claudeDir, 'skills-disabled', 'linked')).isSymbolicLink());
  assert.equal(existsSync(join(skills, 'linked')), false);
  assert.ok(existsSync(join(target, 'SKILL.md')), 'target untouched');
  const on = await req<Skill>('POST', '/api/skills/user:linked/toggle');
  assert.equal(on.body.disabled, false);
  assert.ok(lstatSync(join(skills, 'linked')).isSymbolicLink());
});

test('skill create, preview diff, bad names', async () => {
  register();
  const preview = await req<{ diff: string }>('POST', '/api/skills/preview', { name: 'n', content: 'hello\n' });
  assert.match(preview.body.diff, /\+hello/);
  assert.equal(existsSync(join(kit.paths.claudeDir, 'skills', 'n')), false, 'preview does not write');

  for (const bad of ['../evil', '-rf', 'a/b', '']) {
    assert.equal((await req('POST', '/api/skills', { name: bad, content: 'x' })).status, 400, bad);
  }
  const created = await req<Skill>('POST', '/api/skills', { name: 'n', content: skillMd('новый') });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, 'user:n');
  assert.equal((await req('POST', '/api/skills', { name: 'n', content: 'x' })).status, 409);

  const previewEdit = await req<{ diff: string }>('POST', '/api/skills/preview', { id: 'user:n', content: skillMd('другой') });
  assert.match(previewEdit.body.diff, /-description: новый\n\+description: другой/);
  assert.equal((await req('GET', '/api/skills/user:missing')).status, 404);
  assert.equal(kit.audits.filter((a) => a.action === 'skill.create').length, 1);
});

// ---------- MCP ----------

test('redaction: args, URL query, userinfo, tokens', () => {
  assert.deepEqual(redactArgs(['-y', 'pkg', '--api-key', SECRET, `--token=${SECRET}`, `API_KEY=${SECRET}`, '-e', `FOO=${SECRET}`, '--header', `X-Thing: ${SECRET}`, '--port=8080', SECRET, '/a/b/script.py']),
    ['-y', 'pkg', '--api-key', '***', '--token=***', 'API_KEY=***', '-e', 'FOO=***', '--header', 'X-Thing=***', '--port=8080', '***', '/a/b/script.py']);
  assert.equal(redactUrl(`https://user:pw@mcp.example.com/mcp/${SECRET}?key=${SECRET}&mode=a`), 'https://mcp.example.com/mcp/***?key=***&mode=***');
  assert.equal(redactUrl('https://mcp.sentry.dev/mcp'), 'https://mcp.sentry.dev/mcp');
  const server = publicServer('x', 'user', null, { command: 'npx', args: [`https://a.b/?t=${SECRET}`], env: { TOKEN: SECRET }, headers: { Authorization: `Bearer ${SECRET}` } });
  assert.ok(!JSON.stringify(server).includes(SECRET));
  assert.deepEqual(server.envKeys, ['TOKEN', 'Authorization']);
});

test('GET /api/mcp: scopes, only keys, no secret anywhere in the response', async () => {
  const root = join(kit.base, 'pr');
  kit.addProject('pr', root);
  kit.write(kit.paths.claudeJson, JSON.stringify({
    mcpServers: { user1: { type: 'stdio', command: 'npx', args: ['--token', SECRET], env: { API_KEY: SECRET } } },
    projects: { [root]: { mcpServers: { local1: { type: 'http', url: `https://x.y/mcp?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } } } } },
  }));
  kit.write(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { proj1: { command: 'node', args: ['s.js'], env: { DB_PASSWORD: SECRET } } } }));
  const install = join(kit.paths.claudeDir, 'plugins/cache/m/figma/1');
  kit.write(join(install, '.mcp.json'), JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { 'X-B': SECRET } } } }));
  kit.write(join(kit.paths.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'figma@m': [{ scope: 'user', installPath: install }] } }));
  register();

  const res = await req<McpServer[]>('GET', '/api/mcp');
  assert.ok(!res.text.includes(SECRET), 'secret leaked into /api/mcp');
  const by = new Map(res.body.map((s) => [s.name, s]));
  assert.deepEqual([...by.keys()].sort(), ['local1', 'plugin:figma:figma', 'proj1', 'user1']);
  assert.equal(by.get('user1')!.scope, 'user');
  assert.deepEqual(by.get('user1')!.envKeys, ['API_KEY']);
  assert.equal(by.get('local1')!.scope, 'local');
  assert.equal(by.get('local1')!.project, 'pr');
  assert.deepEqual(by.get('local1')!.envKeys, ['Authorization']);
  assert.equal(by.get('proj1')!.scope, 'project');
  assert.equal(by.get('plugin:figma:figma')!.scope, 'plugin');
  assert.equal(by.get('user1')!.health, null);
});

test('mcp check runs on demand only and passes only the status, not the printed env', async () => {
  const log = fakeClaude(`if [ "$2" = get ]; then printf 'x:\\n  Status: ✔ Connected\\n  Environment:\\n    API_KEY=${SECRET}\\n'; fi`);
  kit.write(kit.paths.claudeJson, JSON.stringify({ mcpServers: { x: { command: 'npx', env: { API_KEY: SECRET } } } }));
  register();
  await req('GET', '/api/mcp');
  assert.equal(logLines(log).length, 0, 'listing never spawns claude');

  const res = await req<McpServer>('POST', '/api/mcp/x/check');
  assert.equal(res.body.health, '✔ Connected');
  assert.ok(!res.text.includes(SECRET));
  assert.deepEqual(logLines(log)[0], ['mcp', 'get', 'x']);
  assert.equal((await req<McpServer[]>('GET', '/api/mcp')).body[0].health, '✔ Connected');
  assert.equal(parseHealth('no such line'), null);
});

test('mcp add: confirmed required, goes through the CLI by argv, never leaks values', async () => {
  const log = fakeClaude();
  const root = join(kit.base, 'pr');
  kit.addProject('pr', root);
  register();
  const json = { type: 'stdio', command: 'npx', args: ['a'], env: { TOKEN: SECRET } };

  assert.equal((await req('POST', '/api/mcp', { name: 'n', scope: 'user', json })).status, 400);
  assert.equal(logLines(log).length, 0, 'not confirmed: CLI not called');
  assert.equal((await req('POST', '/api/mcp', { name: '--evil', scope: 'user', json, confirmed: true })).status, 400);
  assert.equal((await req('POST', '/api/mcp', { name: 'n', scope: 'global', json, confirmed: true })).status, 400);
  assert.equal((await req('POST', '/api/mcp', { name: 'n', scope: 'local', json, confirmed: true })).status, 400, 'local needs a project');
  assert.equal((await req('POST', '/api/mcp', { name: 'n', scope: 'user', json: 'not json', confirmed: true })).status, 400);

  const ok = await req<McpServer>('POST', '/api/mcp', { name: 'n', scope: 'user', json: JSON.stringify(json), confirmed: true });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes(SECRET));
  assert.deepEqual(logLines(log)[0], ['mcp', 'add-json', '--scope', 'user', 'n', JSON.stringify(json)]);
  assert.ok(!JSON.stringify(kit.audits).includes(SECRET), 'audit holds no values');
  assert.ok(kit.audits.some((a) => a.action === 'mcp.add'));
});

test('mcp add failure does not echo secret values; remove uses --scope and refuses plugins', async () => {
  const log = fakeClaude(`if [ "$2" = add-json ]; then echo "bad config $6" >&2; exit 1; fi`);
  kit.write(kit.paths.claudeJson, JSON.stringify({ mcpServers: { u: { command: 'a' } } }));
  register();
  const failed = await req('POST', '/api/mcp', { name: 'n', scope: 'user', json: { command: 'x', env: { T: SECRET } }, confirmed: true });
  assert.equal(failed.status, 422);
  assert.ok(!failed.text.includes(SECRET));

  assert.equal((await req('DELETE', '/api/mcp/u')).status, 400, 'scope is mandatory');
  assert.equal((await req('DELETE', '/api/mcp/plugin:x:y?scope=plugin')).status, 400);
  assert.equal((await req('DELETE', '/api/mcp/missing?scope=user')).status, 404);
  assert.equal((await req('DELETE', '/api/mcp/u?scope=user')).status, 200);
  assert.deepEqual(logLines(log).at(-1), ['mcp', 'remove', '--scope', 'user', 'u']);
});

// ---------- actions ----------

test('an unapproved command is refused, a changed command needs approval again', async () => {
  const marker = join(kit.base, 'ran');
  const cmd = `touch "${marker}"; echo done`;
  writeConfig('actions.json', [{ id: 'a', title: 'A', command: cmd }]);
  register();

  let def = (await req<ActionDef[]>('GET', '/api/actions')).body.find((a) => a.id === 'a')!;
  assert.equal(def.approved, false);
  const refused = await req<{ error: string; command: string; sha256: string }>('POST', '/api/actions/a/run', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'pending approval');
  assert.equal(refused.body.sha256, sha256(cmd));
  assert.equal(existsSync(marker), false, 'command did not run');

  const approved = await req<ActionDef>('POST', '/api/actions/a/approve', { command: cmd });
  assert.equal(approved.body.approved, true);
  assert.ok(kit.audits.some((x) => x.action === 'command.approve' && x.diff?.includes(cmd)));
  assert.deepEqual(JSON.parse(readFileSync(join(kit.paths.data, 'approved-commands.json'), 'utf8')), [sha256(cmd)]);
  const ran = await req<{ ok: boolean; output: string }>('POST', '/api/actions/a/run', {});
  assert.equal(ran.status, 200);
  assert.match(ran.body.output, /done/);
  assert.ok(existsSync(marker));

  const marker2 = join(kit.base, 'ran2');
  const changed = `touch "${marker2}"`;
  writeConfig('actions.json', [{ id: 'a', title: 'A', command: changed }]);
  def = (await req<ActionDef[]>('GET', '/api/actions')).body.find((a) => a.id === 'a')!;
  assert.equal(def.approved, false);
  assert.equal((await req('POST', '/api/actions/a/run', {})).status, 409);
  assert.equal(existsSync(marker2), false, 'the changed command did not run');
  assert.equal((await req('POST', '/api/actions/a/approve', { command: cmd })).status, 409, 'approving what the user no longer sees');
  assert.equal((await req<ActionDef>('POST', '/api/actions/a/approve', { command: changed })).body.approved, true);
  assert.equal((await req('POST', '/api/actions/a/run', {})).status, 200);
  assert.ok(existsSync(marker2));
});

test('no endpoint runs a command sent by the browser', async () => {
  const marker = join(kit.base, 'evil');
  register();
  assert.equal((await req('POST', '/api/actions/nope/run', { command: `touch "${marker}"` })).status, 404);
  assert.equal((await req('POST', '/api/actions/builtin:shell/approve')).status, 400);
  assert.equal(existsSync(marker), false);
});

test('argv injection: bad cwd and sessionId refused, values reach an approved command only as $1/$2', async () => {
  const fake = join(kit.base, 'bin');
  const wtLog = join(kit.base, 'wt.log');
  fakeBin(join(fake, 'wt.exe'), wtLog);
  process.env.PATH = `${fake}:${savedPath}`;
  const marker = join(kit.base, 'pwned');
  const good = join(kit.base, 'dir with пробел');
  mkdirSync(good);
  const semi = join(kit.base, 'dir;x');
  mkdirSync(semi);
  register();

  const badCwds = [`/tmp; touch ${marker}`, `$(touch ${marker})`, `\`touch ${marker}\``, 'relative/path', `${good}/../..`, `${good}\ntouch`, semi, `/nonexistent`, '-rf', 5, ''];
  for (const cwd of badCwds) {
    assert.equal((await req('POST', '/api/actions/builtin:terminal/run', { cwd })).status, 400, `cwd ${String(cwd)}`);
    assert.equal((await req('POST', '/api/actions/builtin:shell/run', { cwd })).status, 400, `cwd ${String(cwd)}`);
  }
  const uuid = '11111111-2222-3333-4444-555555555555';
  for (const sessionId of [`${uuid}; touch ${marker}`, `$(touch ${marker})`, '--dangerously-skip-permissions', 'abc']) {
    assert.equal((await req('POST', '/api/actions/builtin:terminal/run', { cwd: good, sessionId })).status, 400, `sessionId ${sessionId}`);
  }
  assert.equal(logLines(wtLog).length, 0);
  assert.equal(existsSync(marker), false);

  assert.equal((await req('POST', '/api/actions/builtin:terminal/run', { cwd: good, sessionId: uuid })).status, 200);
  await until(() => logLines(wtLog).length === 1);
  assert.deepEqual(logLines(wtLog)[0].slice(0, 4), ['wsl.exe', '-d', process.env.WSL_DISTRO_NAME ?? 'Ubuntu-22.04', '--cd']);
  assert.deepEqual(logLines(wtLog)[0].slice(4), [good, '--', kit.paths.claudeBin, '--resume', uuid]);

  // The plain shell: a folder and nothing else, the user types in it.
  assert.equal((await req('POST', '/api/actions/builtin:shell/run', { cwd: good, sessionId: uuid })).status, 200);
  await until(() => logLines(wtLog).length === 2);
  assert.deepEqual(logLines(wtLog)[1], ['wsl.exe', '-d', process.env.WSL_DISTRO_NAME ?? 'Ubuntu-22.04', '--cd', good]);
  assert.equal((await req('POST', '/api/open-terminal', { cwd: good })).status, 200);
  await until(() => logLines(wtLog).length === 3);
  assert.deepEqual(logLines(wtLog)[2].slice(-2), ['--', kit.paths.claudeBin]);

  writeConfig('actions.json', [{ id: 'echo', title: 'E', command: 'printf "%s|%s" "$1" "$2"; pwd', cwd: '{cwd}' }]);
  await req('POST', '/api/actions/echo/approve');
  const ran = await req<{ output: string }>('POST', '/api/actions/echo/run', { cwd: good, sessionId: uuid });
  assert.equal(ran.body.output, `${good}|${uuid}${good}\n`);
});

test('project action resolves root; unknown project is 404', async () => {
  const root = join(kit.base, 'pr');
  kit.addProject('pr', root);
  writeConfig('actions.json', [{ id: 'where', title: 'W', command: 'pwd', cwd: '{project}' }]);
  register();
  await req('POST', '/api/actions/where/approve');
  assert.equal((await req<{ output: string }>('POST', '/api/actions/where/run', { project: 'pr' })).body.output, `${root}\n`);
  assert.equal((await req('POST', '/api/actions/where/run', { project: 'nope' })).status, 404);
});

// ---------- widgets ----------

const widgetMessages = (id: string) => kit.messages.flatMap((m) => (m.t === 'widget' && m.value.id === id ? [m.value] : []));

test('command widget: runs only when approved, broadcasts, a changed command stops', async () => {
  const marker = join(kit.base, 'w');
  const cmd = `touch "${marker}"; echo 42`;
  writeConfig('widgets.json', [{ id: 'c', title: 'C', type: 'command', command: cmd, intervalSec: 60 }]);
  register();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(marker), false, 'unapproved widget never ran');
  let list = await req<{ defs: WidgetDef[]; values: WidgetValue[] }>('GET', '/api/widgets');
  assert.equal(list.body.defs[0].approved, false);
  assert.equal(list.body.values[0].error, 'pending approval');

  const approved = await req<WidgetDef>('POST', '/api/widgets/c/approve', { command: cmd });
  assert.equal(approved.body.approved, true);
  await until(() => widgetMessages('c').some((v) => v.value === '42'));
  assert.ok(existsSync(marker));
  list = await req('GET', '/api/widgets');
  assert.equal(list.body.values[0].value, '42');

  const marker2 = join(kit.base, 'w2');
  writeConfig('widgets.json', [{ id: 'c', title: 'C', type: 'command', command: `touch "${marker2}"; echo 43`, intervalSec: 60 }]);
  await until(() => widgetMessages('c').some((v) => v.error === 'pending approval'), 6000);
  assert.equal(existsSync(marker2), false, 'the changed command waits for approval');
});

test('a widget in the trash runs nothing, keeps its entry, and starts again when it comes back', async () => {
  const marker = join(kit.base, 'trashed');
  const cmd = `touch "${marker}"; echo 7`;
  writeConfig('widgets.json', [{ id: 't', title: 'T', type: 'command', command: cmd, intervalSec: 60, slot: 'right' }]);
  writeConfig('settings.json', { home: { slots: { right: ['t'] }, hidden: ['t'] } });
  register();
  await new Promise((r) => setTimeout(r, 300)); // chokidar scan
  await req('POST', '/api/widgets/t/approve', { command: cmd });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(marker), false, 'approved, but in the trash');
  assert.deepEqual((await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body.defs.map((d) => d.id), ['t'], 'the entry stays: its title is what the trash shows');

  await req('PUT', '/api/settings/home', { slots: { right: ['t'] }, hidden: [] });
  await until(() => widgetMessages('t').some((v) => v.value === '7'), 6000);
  assert.ok(existsSync(marker));
});

test('command widget output is capped, a failure and a timeout-free exit are reported', async () => {
  writeConfig('widgets.json', [
    { id: 'big', title: 'B', type: 'command', command: 'head -c 500000 /dev/zero | tr "\\0" a', intervalSec: 60 },
    { id: 'bad', title: 'F', type: 'command', command: 'exit 3', intervalSec: 60 },
  ]);
  register();
  await req('POST', '/api/widgets/big/approve');
  await req('POST', '/api/widgets/bad/approve');
  await until(() => widgetMessages('big').length > 0 && widgetMessages('bad').some((v) => v.error !== 'pending approval'));
  assert.ok((widgetMessages('big').at(-1)!.value ?? '').length <= 4096);
  assert.equal(widgetMessages('bad').at(-1)!.error, 'exit 3');
});

test('file widget: value, JSON pointer, size cap, auth files refused', () => {
  const plain = kit.write(join(kit.base, 'v.txt'), ' 7 \n');
  assert.equal(readFileWidget(plain), '7');
  const js = kit.write(join(kit.base, 'v.json'), JSON.stringify({ a: { 'b/c': 5, s: 'x' } }));
  assert.equal(readFileWidget(js, '/a/b~1c'), '5');
  assert.equal(readFileWidget(js, '/a/s'), 'x');
  assert.throws(() => readFileWidget(js, '/nope'));
  assert.ok(readFileWidget(kit.write(join(kit.base, 'big'), 'x'.repeat(200_000))).length <= 4096);
  assert.throws(() => readFileWidget(kit.write(join(kit.base, '.credentials.json'), '{}')), /secret/);
  const link = join(kit.base, 'innocent');
  symlinkSync(join(kit.base, '.credentials.json'), link);
  assert.throws(() => readFileWidget(link), /secret/);
});

test('note widget shows the first lines; add and delete widgets; config watched', async () => {
  kit.write(join(kit.paths.claudeDir, 'projects', '-p', 'memory', 'n.md'), '---\nname: x\n---\n# Заголовок\n\nстрока 2\n');
  const v = kit.write(join(kit.base, 'v.txt'), '1');
  register();
  const { nodes } = (await req<{ nodes: { id: string }[] }>('GET', '/api/memory/graph')).body;
  const note = await req<WidgetDef>('POST', '/api/widgets', { title: 'N', type: 'note', noteId: nodes[0].id });
  const file = await req<WidgetDef>('POST', '/api/widgets', { title: 'F', type: 'file', path: v, id: 'forged', approved: true });
  assert.notEqual(file.body.id, 'forged');
  const cmd = await req<WidgetDef>('POST', '/api/widgets', { title: 'C', type: 'command', command: 'echo 1', intervalSec: 60, approved: true });
  assert.equal(cmd.body.approved, false, 'the form cannot pre-approve');
  assert.equal((await req('POST', '/api/widgets', { title: 'bad', type: 'shell', command: 'x' })).status, 400);

  const list = await req<{ values: WidgetValue[] }>('GET', '/api/widgets');
  const value = (id: string) => list.body.values.find((x) => x.id === id);
  assert.equal(value(note.body.id)!.value, '# Заголовок\nстрока 2');
  assert.equal(value(file.body.id)!.value, '1');

  assert.equal((await req('DELETE', `/api/widgets/${note.body.id}`)).status, 200);
  assert.equal((await req('DELETE', '/api/widgets/none')).status, 404);
  assert.ok(kit.audits.some((a) => a.action === 'widget.remove'));

  await new Promise((r) => setTimeout(r, 300)); // chokidar scan
  kit.topics.length = 0;
  writeConfig('widgets.json', [{ id: 'hand', title: 'H', type: 'file', path: v }]);
  await until(() => kit.topics.includes('widgets'));
  assert.deepEqual((await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body.defs.map((d) => d.id), ['hand']);
});

test('a block stands in a slot; the first move retires an old box, and a command in a slot still waits for approval', async () => {
  const marker = join(kit.base, 'block-ran');
  const box = { x: 40, y: 60, w: 240, h: 240 };
  writeConfig('widgets.json', [{ id: 'old', title: 'O', type: 'command', command: 'echo old', intervalSec: 60 }, { id: 'boxed', title: 'B', type: 'block', box }]);
  const before = readFileSync(join(kit.paths.config, 'widgets.json'), 'utf8');
  register();
  const read = (await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body.defs;
  assert.deepEqual(read.find((d) => d.id === 'boxed')?.box, box, 'an old box is still read');
  assert.equal(readFileSync(join(kit.paths.config, 'widgets.json'), 'utf8'), before, 'reading rewrites nothing');

  const block = await req<WidgetDef>('POST', '/api/widgets', { title: 'N', type: 'block', slot: 'top' });
  assert.equal(block.body.slot, 'top');
  assert.equal(block.body.approved, true);
  assert.equal((await req('POST', '/api/widgets', { title: 'bad', type: 'block', content: 5 })).status, 400);

  const moved = await req<WidgetDef>('PUT', `/api/widgets/${block.body.id}/place`, { slot: 'right', height: 200, extra: 'dropped' });
  assert.equal(moved.body.slot, 'right');
  assert.equal(moved.body.height, 200);
  assert.equal((await req('PUT', `/api/widgets/${block.body.id}/place`, { slot: 'middle' })).status, 400);
  assert.equal((await req('PUT', `/api/widgets/${block.body.id}/place`, { slot: 'right', height: 1 })).status, 400);
  assert.equal((await req('PUT', '/api/widgets/none/place', { slot: 'right' })).status, 404);
  assert.ok(kit.audits.some((a) => a.action === 'widget.move'));

  const retired = await req<WidgetDef>('PUT', '/api/widgets/boxed/place', { slot: 'left' });
  assert.equal(retired.body.box, undefined);
  assert.equal(retired.body.height, 240, 'the height of the old box stays');

  const stored = JSON.parse(readFileSync(join(kit.paths.config, 'widgets.json'), 'utf8')) as { id: string; box?: unknown; slot?: string; command?: string }[];
  assert.equal(stored.find((w) => w.id === 'old')?.command, 'echo old', 'the entry without a place survives');
  assert.equal(stored.find((w) => w.id === 'old')?.slot, undefined);
  assert.equal(stored.find((w) => w.id === 'boxed')?.box, undefined);
  assert.equal(stored.find((w) => w.id === 'boxed')?.slot, 'left');

  // What Claude does to fill a block: same id and slot, another type.
  await new Promise((r) => setTimeout(r, 300)); // chokidar scan
  writeConfig('widgets.json', [{ id: 'filled', title: 'F', type: 'command', command: `touch "${marker}"; echo 1`, intervalSec: 60, slot: 'right', height: 180 }, { id: 'broken', title: 'X', type: 'block', box: { x: 1 }, slot: 'middle', height: 'tall' }]);
  await until(() => widgetMessages('filled').some((v) => v.error === 'pending approval'));
  const { defs } = (await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body;
  assert.equal(defs[0].approved, false);
  assert.equal(defs[0].slot, 'right');
  assert.equal(defs[0].height, 180);
  assert.equal(defs[1].box, undefined, 'a broken box is no box');
  assert.equal(defs[1].slot, undefined, 'a broken slot is no slot');
  assert.equal(defs[1].height, undefined);
  await req('PUT', '/api/widgets/filled/place', { slot: 'left' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(marker), false, 'moving does not approve');
});

test('a widget action reaches the interface whole; a broken one is no action', async () => {
  const action = { label: 'Go on', cwd: kit.base, prompt: 'continue', readyWhen: 'ready' };
  writeConfig('widgets.json', [
    { id: 'act', title: 'A', type: 'file', path: join(kit.base, 'none'), slot: 'right', action },
    { id: 'half', title: 'H', type: 'block', slot: 'right', action: { label: 'x', cwd: kit.base } },
    { id: 'empty', title: 'E', type: 'block', slot: 'right', action: { label: 'x', cwd: kit.base, prompt: 'p', readyWhen: '' } },
  ]);
  register();
  const { defs } = (await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body;
  assert.deepEqual(defs.find((d) => d.id === 'act')?.action, action);
  assert.equal(defs.find((d) => d.id === 'half')?.action, undefined, 'no prompt, no button');
  assert.equal(defs.find((d) => d.id === 'empty')?.action, undefined, 'an empty readyWhen would always be ready');
});

test('widget keeps icon and description', async () => {
  writeConfig('widgets.json', [
    { id: 'desc', title: 'D', type: 'block', slot: 'right', icon: 'gauge', description: 'What it **shows**' },
    { id: 'long', title: 'L', type: 'block', slot: 'right', description: 'x'.repeat(600) },
    { id: 'bad', title: 'B', type: 'block', slot: 'right', icon: null, description: 7 },
    { id: 'unknown', title: 'U', type: 'block', slot: 'right', icon: 'no-such-icon' },
    { id: 'plain', title: 'P', type: 'block', slot: 'right' },
  ]);
  register();
  const { defs } = (await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body;
  const desc = defs.find((d) => d.id === 'desc')!;
  assert.equal(desc.icon, 'gauge');
  assert.equal(desc.description, 'What it **shows**');
  assert.match(desc.iconSvg ?? '', /^<svg/, 'the library draws it');
  const unknown = defs.find((d) => d.id === 'unknown')!;
  assert.equal(unknown.icon, 'no-such-icon');
  assert.equal(unknown.iconSvg, undefined, 'the interface falls back to its own icon');
  assert.equal(defs.find((d) => d.id === 'long')?.description?.length, 500, 'capped');
  const bad = defs.find((d) => d.id === 'bad')!;
  assert.ok(bad && !('icon' in bad) && !('description' in bad), 'a bad icon or description is ignored, the widget stays');
  const plain = defs.find((d) => d.id === 'plain')!;
  assert.ok(!('icon' in plain) && !('description' in plain));
  assert.equal((await req('PUT', '/api/widgets/desc/place', { slot: 'left' })).status, 200);
  assert.ok((JSON.parse(readFileSync(join(kit.paths.config, 'widgets.json'), 'utf8')) as { id: string }[]).some((w) => w.id === 'bad'), 'and survives a write of the file');
});

test('a widget view is its own file: served only once approved, a changed file waits again, never a path', async () => {
  const cmd = 'echo {}';
  const view = (text: string) => kit.write(join(kit.paths.config, 'widgets', 'w.js'), text);
  const module = async (id: string) => (await kit.app.inject({ method: 'GET', url: `/api/widgets/${id}/view` })).statusCode;
  view('export const activate = () => () => null;\n');
  writeConfig('widgets.json', [
    { id: 'own', title: 'O', type: 'command', command: cmd, intervalSec: 60, slot: 'right', view: 'w.js' },
    { id: 'gone', title: 'G', type: 'block', slot: 'right', view: 'none.js' },
    { id: 'path', title: 'P', type: 'block', slot: 'right', view: '../settings.json' },
  ]);
  register();
  const defs = async () => (await req<{ defs: WidgetDef[] }>('GET', '/api/widgets')).body.defs;
  const own = (await defs()).find((d) => d.id === 'own')!;
  assert.equal(own.view?.file, 'w.js');
  assert.equal(own.view?.approved, false);
  assert.equal(await module('own'), 403, 'unapproved code is not served');
  assert.equal((await defs()).find((d) => d.id === 'gone')?.view?.sha, null, 'a missing file is told apart');
  assert.equal((await defs()).find((d) => d.id === 'path')?.view, undefined, 'a path is no view');

  const source = await req<{ sha: string; text: string }>('GET', '/api/widgets/own/view/source');
  assert.match(source.body.text, /activate/);
  assert.equal((await req('POST', '/api/widgets/own/approve', { command: cmd, view: 'stale' })).status, 409, 'approving code other than what was seen');
  await req('POST', '/api/widgets/own/approve', { command: cmd, view: source.body.sha });
  const approved = (await defs()).find((d) => d.id === 'own')!;
  assert.equal(approved.approved, true, 'one approval covers the command');
  assert.equal(approved.view?.approved, true, 'and the view');
  assert.equal(await module('own'), 200);

  view('export const activate = () => () => "changed";\n');
  assert.equal((await defs()).find((d) => d.id === 'own')?.view?.approved, false);
  assert.equal(await module('own'), 403, 'an edit alone runs nothing');
  await until(() => kit.topics.includes('widgets'));
});

// ---------- profile and setup ----------

test('profile: validated, stored, read by sessions; setup defaults and saves', async () => {
  writeConfig('settings.json', { ides: { scannedAt: 1, list: [] } }); // no IDE scan in a test
  register();
  const dir = join(kit.base, 'projects');
  mkdirSync(dir);
  const fresh = await req<SettingsView>('GET', '/api/settings');
  assert.equal(fresh.body.profile, null);
  assert.deepEqual(fresh.body.setup, { step: 'checks', completedAt: null, tabId: null });
  assert.equal(kit.ctx.settings!.profile(), null);

  const good = { name: 'Ann', language: 'de', projectsDir: dir, questionLevel: 'thorough' };
  assert.equal((await req('PUT', '/api/settings/profile', { name: 'Ann' })).status, 400, 'the first profile needs every field');
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, projectsDir: 'projects' })).status, 400, 'relative projectsDir');
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, projectsDir: join(kit.base, 'missing') })).status, 400, 'missing projectsDir');
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, name: '' })).status, 400);
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, name: 'x'.repeat(61) })).status, 400);
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, name: 'a\nb' })).status, 400, 'no control characters');
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, language: 'German' })).status, 400);
  assert.equal((await req('PUT', '/api/settings/profile', { ...good, questionLevel: 'never' })).status, 400);
  assert.equal(kit.ctx.settings!.profile(), null, 'nothing stored by a refused request');

  const saved = await req<SettingsView>('PUT', '/api/settings/profile', good);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body.profile, good);
  const renamed = await req<SettingsView>('PUT', '/api/settings/profile', { name: 'Anna' });
  assert.deepEqual(renamed.body.profile, { ...good, name: 'Anna' }, 'later a patch is enough');
  assert.deepEqual(kit.ctx.settings!.profile(), { ...good, name: 'Anna' });
  assert.equal((await req<SettingsView>('PUT', '/api/settings/profile', { name: '  Anna  ' })).body.profile?.name, 'Anna', 'stored trimmed');
  rmSync(dir, { recursive: true });
  const moved = await req<SettingsView>('PUT', '/api/settings/profile', { name: 'Ann' });
  assert.equal(moved.status, 200, 'a patch without projectsDir does not check the folder on disk');
  assert.equal((await req('PUT', '/api/settings/profile', { projectsDir: dir })).status, 400, 'a patch with it does');
  writeConfig('settings.json', { ...JSON.parse(readFileSync(join(kit.paths.config, 'settings.json'), 'utf8')), profile: { ...good, name: 'a\u0007b' } });
  assert.equal(kit.ctx.settings!.profile(), null, 'a stored name with control characters does not fit');
  writeConfig('settings.json', { ...JSON.parse(readFileSync(join(kit.paths.config, 'settings.json'), 'utf8')), profile: { ...good, name: 'Anna' } });

  kit.ctx.settings!.saveSetup({ step: 'onboarding', tabId: 't1' });
  kit.ctx.settings!.saveSetup({ completedAt: 5 });
  assert.deepEqual(kit.ctx.settings!.setup(), { step: 'onboarding', completedAt: 5, tabId: 't1' });
  const stored = JSON.parse(readFileSync(join(kit.paths.config, 'settings.json'), 'utf8'));
  assert.equal(stored.ides.scannedAt, 1, 'the rest of the file stays');
  assert.equal(stored.profile.name, 'Anna');
});
