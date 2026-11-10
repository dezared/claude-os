import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { EntityStats, McpAdminRow, McpReport, McpServer, PluginsReport, ProjectIcons, Skill, SkillsReport, ClaudeMdReport, HooksReport, SettingsView } from '../../shared/contract.ts';
import { initSchema } from '../journal/db.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { hookRows, isNewer, mcpLoginArgv, mcpPrefix, mergeMcpRows, parseMcpTool, resolveSkillRun, windowForecast, worstStatus, type ProbedServer } from './admin.ts';
import { createApprovals } from './approvals.ts';
import { obsidianState } from './ide.ts';
import { registerTools } from './index.ts';
import { sanitizeSvg, MAX_ICON_BYTES } from './projectIcons.ts';
import { createSettings } from './settings.ts';

const skill = (over: Partial<Skill>): Skill => ({ id: 'x', name: 'x', scope: 'user', source: null, description: null, path: '/x', readOnly: false, disabled: false, isSymlink: false, usageCount: 0, lastUsedAt: null, ...over });

describe('icon sanitizer', () => {
  const svg = (inner: string, attrs = '') => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;

  it('keeps a plain flat icon and drops comments, the prolog and a title', () => {
    const r = sanitizeSvg(`<?xml version="1.0"?>\n<!-- hi -->${svg('<title>x</title><path d="M1 1L2 2" fill="#d97757"/><circle cx="3" cy="3" r="1"></circle>')}`);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.svg, /^<svg viewBox="0 0 24 24" xmlns="[^"]+"><path d="M1 1L2 2" fill="#d97757"\/><circle cx="3" cy="3" r="1"><\/circle><\/svg>$/);
      assert.doesNotMatch(r.svg, /title|xml version|hi/);
    }
  });

  it('adds a missing namespace, so an img can render it', () => {
    const r = sanitizeSvg('<svg viewBox="0 0 2 2"><rect width="1" height="1"/></svg>');
    assert.ok(r.ok && r.svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('rejects everything active, external or malformed', () => {
    const attacks: [string, string][] = [
      ['script', svg('<script>alert(1)</script>')],
      ['handler', svg('<path d="M0 0" onload="alert(1)"/>')],
      ['handler on root', svg('<g/>', ' onclick="x()"')],
      ['href', svg('<use href="#a"/>')],
      ['xlink', svg('<a xlink:href="javascript:alert(1)"><path d="M0 0"/></a>')],
      ['image', svg('<image href="https://evil.test/x.png"/>')],
      ['foreignObject', svg('<foreignObject><body/></foreignObject>')],
      ['style element', svg('<style>*{fill:url(https://evil.test)}</style>')],
      ['style attribute', svg('<path d="M0 0" style="fill:red"/>')],
      ['url fill', svg('<path d="M0 0" fill="url(https://evil.test#a)"/>')],
      ['local url', svg('<path d="M0 0" fill="url(#a)"/>')],
      ['data value', svg('<path d="M0 0" fill="data:x"/>')],
      ['entity', '<!DOCTYPE svg [<!ENTITY x "y">]>' + svg('<path d="M0 0"/>')],
      ['cdata', svg('<![CDATA[<script>x</script>]]>')],
      ['text', svg('hello')],
      ['no viewBox', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
      ['wrong namespace', '<svg viewBox="0 0 1 1" xmlns="http://evil.test"></svg>'],
      ['not svg', '<html></html>'],
      ['unbalanced', '<svg viewBox="0 0 1 1"><g></svg>'],
      ['two roots', `${svg('<g/>')}${svg('<g/>')}`],
      ['unquoted', svg('<path d=M0 />')],
      ['entity in value', svg('<path d="M0 0" fill="&#106;avascript:x"/>')],
      ['too large', svg(`<path d="${'M0 0'.repeat(MAX_ICON_BYTES)}"/>`)],
      ['empty', ''],
    ];
    for (const [name, source] of attacks) assert.equal(sanitizeSvg(source).ok, false, name);
  });
});

describe('MCP merge', () => {
  const user = (name: string, summary = 'cmd'): McpServer => ({ name, scope: 'user', project: null, transport: 'stdio', summary, envKeys: ['API_KEY'], health: null });
  const local = (name: string, project: string): McpServer => ({ name, scope: 'local', project, transport: 'http', summary: 'https://x.test', envKeys: [], health: null });
  const merge = (servers: McpServer[], probes: Record<string, ProbedServer[]>) => mergeMcpRows(servers, new Map(Object.entries(probes)), (k) => `name-of-${k}`, new Map(), new Map([['figma', 'Design tools']]));
  const row = (rows: McpAdminRow[], name: string) => rows.find((r) => r.name === name)!;

  it('real statuses, not guesses: unchecked until probed, then what the CLI said', () => {
    assert.equal(merge([user('a')], {})[0].status, 'unchecked');
    const rows = merge([user('a'), user('b'), user('gone')], { global: [
      { name: 'a', status: 'connected', source: 'user', serverInfo: { name: 'A', version: '1' }, tools: [{ name: 't', annotations: { readOnly: true } }] },
      { name: 'b', status: 'failed', error: 'boom', source: 'user' },
      { name: 'plugin:figma:figma', status: 'needs-auth', source: 'plugin' },
      { name: 'claude.ai Docs', status: 'connected', source: 'claudeai' },
    ] });
    assert.equal(row(rows, 'a').status, 'connected');
    assert.deepEqual(row(rows, 'a').tools, [{ name: 't', description: null, readOnly: true, destructive: false }]);
    assert.equal(row(rows, 'b').status, 'failed');
    assert.equal(row(rows, 'b').error, 'boom');
    assert.equal(row(rows, 'gone').status, 'not-loaded');
    assert.equal(row(rows, 'plugin:figma:figma').status, 'needs-auth');
    assert.equal(row(rows, 'plugin:figma:figma').where.plugin, 'figma');
    assert.equal(row(rows, 'plugin:figma:figma').description, 'Design tools');
    assert.equal(row(rows, 'claude.ai Docs').where.account, true);
    assert.equal(rows[0].name, 'plugin:figma:figma', 'what needs the user comes first');
  });

  it('one row per server, with every place it is active', () => {
    const rows = merge([user('s'), local('s', 'p1'), local('s', 'p2'), local('only', 'p1')], {});
    assert.equal(rows.length, 2);
    assert.equal(row(rows, 's').where.global, true);
    assert.deepEqual(row(rows, 's').where.projects.map((p) => p.name), ['name-of-p1', 'name-of-p2']);
    assert.equal(row(rows, 's').definitions.length, 3);
    assert.equal(row(rows, 'only').where.global, false);
  });

  it('the worst place decides', () => {
    assert.equal(worstStatus(['connected', 'needs-auth']), 'needs-auth');
    assert.equal(worstStatus([]), 'unchecked');
    const rows = merge([user('s'), local('s', 'p1')], { global: [{ name: 's', status: 'connected' }], p1: [{ name: 's', status: 'failed', error: 'x' }] });
    assert.equal(row(rows, 's').status, 'failed');
    assert.equal(row(rows, 's').statusBy.length, 2);
  });

  it('tool names map back to servers', () => {
    assert.equal(mcpPrefix('plugin:figma:figma'), 'plugin_figma_figma');
    assert.equal(mcpPrefix('claude.ai Claude Docs'), 'claude_ai_Claude_Docs');
    assert.deepEqual(parseMcpTool('mcp__plugin_figma_figma__authenticate'), { server: 'plugin_figma_figma', tool: 'authenticate' });
    assert.equal(parseMcpTool('Read'), null);
  });

  it('login opens a terminal on Windows and WSL only, the name stays one argument', () => {
    const wsl = mcpLoginArgv('wsl', '/p', '/bin/claude', 'claude.ai Docs', 'Ubuntu')!;
    assert.deepEqual(wsl, { bin: 'wt.exe', args: ['wsl.exe', '-d', 'Ubuntu', '--cd', '/p', '--', '/bin/claude', 'mcp', 'login', 'claude.ai Docs'] });
    assert.equal(mcpLoginArgv('windows', 'C:/p', 'claude', 'x', '')!.bin, 'wt.exe');
    assert.equal(mcpLoginArgv('linux', '/p', 'claude', 'x', ''), null);
  });
});

describe('small rules', () => {
  it('skill runs: a qualified plugin name, then the project, then personal, then plugin', () => {
    const list = [skill({ id: 'u', name: 'a' }), skill({ id: 'p', name: 'a', scope: 'project', source: 'proj' }), skill({ id: 'pl', name: 'a', scope: 'plugin', source: 'plug' }), skill({ id: 'only', name: 'b', scope: 'plugin', source: 'plug' })];
    assert.equal(resolveSkillRun('plug:a', null, list)?.id, 'pl');
    assert.equal(resolveSkillRun('a', 'proj', list)?.id, 'p');
    assert.equal(resolveSkillRun('a', 'other', list)?.id, 'u');
    assert.equal(resolveSkillRun('b', null, list)?.id, 'only');
    assert.equal(resolveSkillRun('nope', null, list), null);
  });

  it('weekly forecast is straight extrapolation, and refuses when it would mean nothing', () => {
    const now = 1_000_000_000_000;
    const week = 7 * 86_400_000;
    const base = { kind: 'weekly_all', label: null, severity: null, active: true };
    const half = windowForecast({ ...base, percent: 30, resetsAt: now + week / 2 }, now)!;
    assert.equal(half.projected, 60);
    assert.equal(half.hitsAt, null);
    const fast = windowForecast({ ...base, percent: 80, resetsAt: now + week / 2 }, now)!;
    assert.equal(fast.projected, 160);
    assert.equal(fast.hitsAt, now + (20 / 80) * (week / 2));
    assert.equal(windowForecast({ ...base, percent: 1, resetsAt: now + week - 1000 }, now)!.projected, null);
    assert.equal(windowForecast({ ...base, percent: null, resetsAt: now + 1000 }, now), null);
    assert.equal(windowForecast({ ...base, kind: 'other', percent: 5, resetsAt: now + 1000 }, now), null);
  });

  it('plugin versions compare as numbers', () => {
    assert.equal(isNewer('1.10.0', '1.9.0'), true);
    assert.equal(isNewer('1.0.0', '1.0.0'), false);
    assert.equal(isNewer('1.0.0', '2.0.0'), false);
  });

  it('hook commands are masked', () => {
    const rows = hookRows({ hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'notify --token=abcdefgh ok' }] }] } }, { scope: 'user', project: null, plugin: null, file: 'f' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'Stop');
    assert.doesNotMatch(rows[0].summary, /abcdefgh/);
    assert.deepEqual(hookRows({}, { scope: 'user', project: null, plugin: null, file: 'f' }), []);
  });
});

describe('Obsidian detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-os-obsidian-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('a handler counts only if its target exists; a stale one does not', () => {
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: null }), { installed: false, exe: null });
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: { exe: 'C:\\gone\\Obsidian.exe', exists: false } }), { installed: false, exe: null });
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: { exe: 'C:\\app\\Obsidian.exe', exists: true } }), { installed: true, exe: 'C:\\app\\Obsidian.exe' });
  });

  it('the recheck flips the state without a restart and survives a failed probe', async () => {
    const results: ({ installed: boolean; exe: string | null } | Error)[] = [
      { installed: false, exe: null },
      new Error('powershell died'),
      { installed: true, exe: 'C:\\app\\Obsidian.exe' },
    ];
    const ctx = { paths: { config: dir, data: dir, vault: dir }, invalidate() {}, audit() {}, app: { log: { warn() {} } } } as never;
    const settings = createSettings(ctx, createApprovals(ctx), async () => ({ ides: [], obsidianInstalled: false, obsidianExe: null }), async () => {
      const r = results.shift()!;
      if (r instanceof Error) throw r;
      return r;
    });
    assert.equal((await settings.recheckObsidian()).obsidian.installed, false);
    assert.equal((await settings.recheckObsidian()).obsidian.installed, false, 'a failure changes nothing');
    const next: SettingsView = await settings.recheckObsidian();
    assert.equal(next.obsidian.installed, true);
    assert.equal(next.obsidian.exe, 'C:\\app\\Obsidian.exe');
  });

  it('opens only obsidian:// note links, and only with a known program', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-open-'));
    const ctx = { paths: { config: dir, data: dir, vault: dir }, invalidate() {}, audit() {}, app: { log: { warn() {} } } } as never;
    const settings = createSettings(ctx, createApprovals(ctx), async () => ({ ides: [], obsidianInstalled: false, obsidianExe: null }));
    await assert.rejects(settings.openObsidian('https://example.com'), /bad obsidian url/);
    await assert.rejects(settings.openObsidian('obsidian://open?path=x'), /not found/);
  });
});

describe('routes on real files', () => {
  let kit: TestKit;
  const get = async <T>(url: string) => {
    const res = await kit.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as T;
  };
  beforeEach(() => {
    kit = makeKit();
    kit.ctx.db = new DatabaseSync(':memory:');
    initSchema(kit.ctx.db);
    registerTools(kit.ctx);
  });
  afterEach(async () => {
    await kit.close();
    kit.ctx.db.close();
  });

  it('reports are empty and honest on a fresh machine; nothing is probed by reading', async () => {
    const skills = await get<SkillsReport>('/api/admin/skills');
    assert.deepEqual(skills.rows, []);
    assert.equal(skills.byDay.length, 30);
    const mcp = await get<McpReport>('/api/admin/mcp');
    assert.deepEqual(mcp.rows, []);
    assert.deepEqual(mcp.probes, {});
    assert.deepEqual((await get<HooksReport>('/api/admin/hooks')).rows, []);
    assert.deepEqual((await get<PluginsReport>('/api/admin/plugins')).rows, []);
  });

  it('MCP secrets stay masked in the report', async () => {
    writeFileSync(kit.paths.claudeJson, JSON.stringify({ mcpServers: { s: { type: 'stdio', command: 'x', args: ['--token=supersecretvalue'], env: { API_KEY: 'envsecretvalue' } }, h: { type: 'http', url: 'https://a.test/mcp?key=urlsecretvalue', headers: { Authorization: 'Bearer headersecretvalue' } } } }));
    const text = JSON.stringify(await get<McpReport>('/api/admin/mcp'));
    assert.doesNotMatch(text, /supersecretvalue|envsecretvalue|urlsecretvalue|headersecretvalue/);
    assert.match(text, /API_KEY/);
  });

  it('counts skill and MCP use from the journals, and hooks from settings', async () => {
    const dir = join(kit.paths.claudeDir, 'skills', 'used');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: used\ndescription: d\n---\n');
    mkdirSync(join(kit.paths.claudeDir, 'skills', 'idle'), { recursive: true });
    writeFileSync(join(kit.paths.claudeDir, 'skills', 'idle', 'SKILL.md'), '---\nname: idle\n---\n');
    writeFileSync(kit.paths.claudeJson, JSON.stringify({ mcpServers: { semble: { type: 'stdio', command: 'x' } } }));
    writeFileSync(join(kit.paths.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo --token=abcdefghij' }] }] } }));
    const now = Date.now();
    kit.ctx.db.prepare(`INSERT INTO usage_log (tool_id, session, tool, target, kind, op, ts) VALUES ('a', 's', 'Skill', 'used', 'skill', 'use', ?), ('b', 's', 'Skill', 'used', 'skill', 'use', ?), ('c', 's', 'Skill', 'removed-long-ago', 'skill', 'use', ?)`).run(now, now - 40 * 86_400_000, now);
    kit.ctx.db.prepare(`INSERT INTO tool_calls (id, name, skill, session, ts) VALUES ('t1', 'mcp__semble__search', NULL, 's', ?), ('t2', 'mcp__semble__find', NULL, 's', ?), ('t3', 'mcp__gone__x', NULL, 's', ?), ('t4', 'mcp__semble__old', NULL, 's', ?)`).run(now, now, now, now - 40 * 86_400_000);

    const s = await get<SkillsReport>('/api/admin/skills');
    const used = s.rows.find((r) => r.name === 'used')!;
    assert.equal(used.runs, 1, 'only the window');
    assert.equal(used.runsAll, 2);
    assert.equal(s.rows.find((r) => r.name === 'idle')!.runs, 0);
    assert.deepEqual(s.gone.map((g) => g.name), ['removed-long-ago']);

    const m = await get<McpReport>('/api/admin/mcp');
    const semble = m.rows.find((r) => r.name === 'semble')!;
    assert.equal(semble.calls, 2);
    assert.equal(semble.toolsUsed, 2);
    assert.deepEqual(m.gone.map((g) => g.name), ['gone']);

    const h = await get<HooksReport>('/api/admin/hooks');
    assert.equal(h.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(h), /abcdefghij/);
  });

  it('forecast: average over full past days, today apart', async () => {
    const day = 86_400_000;
    const now = Date.now();
    const ins = kit.ctx.db.prepare(`INSERT INTO usage_messages (message_id, session, ts, day, model, is_subagent, input, output, cache_read, cache_write) VALUES (?, 's', ?, ?, 'm', 0, 100, 0, 999, 0)`);
    const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    ins.run('a', now - day, dayOf(now - day));
    ins.run('b', now - 2 * day, dayOf(now - 2 * day));
    ins.run('old', now - 30 * day, dayOf(now - 30 * day));
    ins.run('today', now, dayOf(now));
    const f = await get<{ basisDays: number; activeDays: number; dailyAverage: number; today: number; weekProjected: number; todayHours: number[] }>('/api/admin/forecast');
    assert.equal(f.basisDays, 14);
    assert.equal(f.activeDays, 2);
    assert.equal(f.dailyAverage, Math.round(200 / 14));
    assert.equal(f.today, 100);
    assert.equal(f.todayHours.reduce((a, b) => a + b, 0), 100);
    assert.equal(f.weekProjected, Math.round((200 / 14) * 7));
  });

  it('project icons: clean ones served, bad and symlinked ones reported, the offer remembered', async () => {
    const dir = join(kit.paths.config, 'project-icons');
    writeFileSync(join(dir, 'good.svg'), '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>');
    writeFileSync(join(dir, 'evil.svg'), '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>');
    const outside = join(kit.paths.config, 'secret.txt');
    writeFileSync(outside, '<svg viewBox="0 0 1 1"></svg>');
    symlinkSync(outside, join(dir, 'link.svg'));
    writeFileSync(join(dir, 'huge.svg'), `<svg viewBox="0 0 1 1">${' '.repeat(MAX_ICON_BYTES)}</svg>`);
    const icons = await get<ProjectIcons>('/api/project-icons');
    assert.deepEqual(Object.keys(icons.icons), ['good']);
    assert.deepEqual(icons.rejected.map((r) => r.key).sort(), ['evil', 'huge', 'link']);
    assert.doesNotMatch(JSON.stringify(icons.icons), /script/);
    assert.equal(icons.offerDismissed, false);
    const res = await kit.app.inject({ method: 'POST', url: '/api/project-icons/dismiss-offer' });
    assert.equal((res.json() as ProjectIcons).offerDismissed, true);
    assert.equal((await get<ProjectIcons>('/api/project-icons')).offerDismissed, true);
  });

  it('CLAUDE.md: read, preview, save with a backup, a stale version refused', async () => {
    const path = join(kit.paths.claudeDir, 'CLAUDE.md');
    writeFileSync(path, 'old\n');
    const r = await get<ClaudeMdReport>('/api/claude-md');
    const f = r.files.find((x) => x.scope === 'global')!;
    assert.equal(f.content, 'old\n');
    assert.deepEqual(Object.keys(f).sort(), ['content', 'exists', 'path', 'scope', 'updatedAt', 'version']);
    const preview = await kit.app.inject({ method: 'POST', url: '/api/claude-md/preview', payload: { scope: 'global', content: 'new\n' } });
    assert.match((preview.json() as { diff: string }).diff, /\+new/);
    const stale = await kit.app.inject({ method: 'PUT', url: '/api/claude-md', payload: { scope: 'global', content: 'new\n', version: 'nope' } });
    assert.equal(stale.statusCode, 409);
    const ok = await kit.app.inject({ method: 'PUT', url: '/api/claude-md', payload: { scope: 'global', content: 'new\n', version: f.version } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await get<ClaudeMdReport>('/api/claude-md')).files[0].content, 'new\n');
    const bad = await kit.app.inject({ method: 'PUT', url: '/api/claude-md', payload: { scope: 'nope', content: 'x', version: 'y' } });
    assert.equal(bad.statusCode, 400);
  });

  it('a skill goes with a confirmation: a copy of the folder stays, a link loses only the link, a plugin skill stays', async () => {
    const dir = join(kit.paths.claudeDir, 'skills', 'gone');
    kit.write(join(dir, 'SKILL.md'), '---\nname: gone\n---\nbody\n');
    kit.write(join(dir, 'extra.md'), 'extra');
    const url = `/api/skills/${encodeURIComponent('user:gone')}`;
    assert.equal((await kit.app.inject({ method: 'DELETE', url, payload: {} })).statusCode, 400);
    assert.ok(existsSync(dir), 'no confirmation, no change');

    const res = await kit.app.inject({ method: 'DELETE', url, payload: { confirmed: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(existsSync(dir), false);
    const { backup } = res.json() as { backup: string };
    assert.ok(backup.startsWith(join(kit.paths.data, 'backups')));
    assert.equal(readFileSync(join(backup, 'extra.md'), 'utf8'), 'extra');
    assert.equal(kit.audits.at(-1)!.action, 'skill.delete');

    const target = join(kit.base, 'shared-skill');
    kit.write(join(target, 'SKILL.md'), '---\nname: linked\n---\n');
    symlinkSync(target, join(kit.paths.claudeDir, 'skills', 'linked'));
    const linked = await kit.app.inject({ method: 'DELETE', url: `/api/skills/${encodeURIComponent('user:linked')}`, payload: { confirmed: true } });
    assert.equal((linked.json() as { backup: string | null }).backup, null);
    assert.equal(existsSync(join(kit.paths.claudeDir, 'skills', 'linked')), false);
    assert.ok(existsSync(join(target, 'SKILL.md')), 'the shared target stays');

    const missing = await kit.app.inject({ method: 'DELETE', url: '/api/skills/nobody', payload: { confirmed: true } });
    assert.equal(missing.statusCode, 404);
  });

  it('an MCP definition names its file, and removal goes through claude mcp remove in that place', async () => {
    const root = join(kit.base, 'proj');
    kit.addProject('proj', root);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'x' } } }));
    writeFileSync(kit.paths.claudeJson, JSON.stringify({ mcpServers: { top: { command: 'x' } }, projects: { [root]: { mcpServers: { mine: { command: 'y' } } } } }));
    const { rows } = await get<McpReport>('/api/admin/mcp');
    const fileOf = (name: string) => rows.find((r) => r.name === name)!.definitions[0].file;
    assert.equal(fileOf('top'), kit.paths.claudeJson);
    assert.equal(fileOf('mine'), kit.paths.claudeJson);
    assert.equal(fileOf('shared'), join(root, '.mcp.json'));

    const log = join(kit.base, 'calls.log');
    kit.write(kit.paths.claudeBin, `#!/bin/bash\necho "$PWD|$*" >> "${log}"\n`);
    chmodSync(kit.paths.claudeBin, 0o755);
    const res = await kit.app.inject({ method: 'DELETE', url: '/api/mcp/shared?scope=project&project=proj' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(readFileSync(log, 'utf8').trim(), `${root}|mcp remove --scope project shared`);
  });

  it('entity stats: what the journals and the audit log hold, nothing invented', async () => {
    const dir = join(kit.paths.claudeDir, 'skills', 'used');
    kit.write(join(dir, 'SKILL.md'), '---\nname: used\nauthor: Jane\n---\n');
    kit.addProject('proj', join(kit.base, 'proj'));
    writeFileSync(kit.paths.claudeJson, JSON.stringify({ mcpServers: { semble: { type: 'stdio', command: 'x' } } }));
    kit.ctx.db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER, action TEXT, target TEXT, diff TEXT)');
    const ins = kit.ctx.db.prepare('INSERT INTO audit_log (at, action, target, diff) VALUES (?, ?, ?, NULL)');
    ins.run(5, 'skill.update', join(dir, 'SKILL.md'));
    ins.run(6, 'skill.update', join(kit.paths.claudeDir, 'skills', 'other', 'SKILL.md'));
    ins.run(7, 'mcp.add', 'user:semble');
    const now = Date.now();
    kit.ctx.db.prepare(`INSERT INTO sessions (id, project, first_activity, last_activity) VALUES ('s', 'proj', ?, ?)`).run(now - 50 * 86_400_000, now);
    kit.ctx.db.prepare(`INSERT INTO usage_log (tool_id, session, tool, target, kind, op, ts) VALUES ('a', 's', 'Skill', 'used', 'skill', 'use', ?), ('b', 's', 'Skill', 'used', 'skill', 'use', ?), ('c', 's', 'Skill', 'other', 'skill', 'use', ?)`).run(now, now - 40 * 86_400_000, now);
    kit.ctx.db.prepare(`INSERT INTO tool_calls (id, name, skill, session, ts) VALUES ('t1', 'mcp__semble__search', NULL, 's', ?), ('t2', 'mcp__semble__search', NULL, 's', ?), ('t3', 'mcp__semble__find', NULL, 's', ?), ('t4', 'mcp__semblex__find', NULL, 's', ?), ('t5', 'Read', NULL, 's', ?)`).run(now, now, now - 40 * 86_400_000, now, now);
    kit.ctx.db.prepare(`INSERT INTO usage_messages (message_id, session, ts, day, model, is_subagent, input, output, cache_read, cache_write) VALUES ('m1', 's', ?, 'd', 'claude-x', 0, 10, 5, 999, 1), ('m2', 's', ?, 'd', '<synthetic>', 0, 1, 0, 0, 0)`).run(now, now - 40 * 86_400_000);

    const skill = await get<EntityStats>(`/api/admin/entity?type=skill&id=${encodeURIComponent('user:used')}`);
    assert.deepEqual([skill.total, skill.recent], [2, 1]);
    assert.deepEqual(skill.byProject, [{ key: 'proj', name: 'proj', n: 1 }]);
    assert.equal(skill.byDay.length, 30);
    assert.equal(skill.byDay.at(-1)!.n, 1);
    assert.deepEqual(skill.meta, { author: 'Jane' });
    assert.deepEqual(skill.history, [{ at: 5, action: 'skill.update' }]);
    assert.ok(skill.changedAt);

    const mcp = await get<EntityStats>('/api/admin/entity?type=mcp&id=semble');
    assert.deepEqual([mcp.total, mcp.recent], [3, 2]);
    assert.deepEqual(mcp.byName, [{ name: 'search', n: 2 }]);
    assert.deepEqual(mcp.history, [{ at: 7, action: 'mcp.add' }]);
    assert.equal(mcp.createdAt, null);
    assert.equal(mcp.changedAt, null, "~/.claude.json's date says nothing about one server");

    const project = await get<EntityStats>('/api/admin/entity?type=project&id=proj');
    assert.deepEqual([project.total, project.recent], [17, 16]);
    assert.deepEqual(project.byModel, [{ name: 'claude-x', n: 16 }]);
    assert.equal(project.createdAt, now - 50 * 86_400_000);
    assert.equal(project.byName.find((x) => x.name === 'Read')!.n, 1);

    const unknown = await kit.app.inject({ method: 'GET', url: '/api/admin/entity?type=skill&id=nobody' });
    assert.equal(unknown.statusCode, 404);
    assert.equal((await kit.app.inject({ method: 'GET', url: '/api/admin/entity?type=nope&id=x' })).statusCode, 400);
  });

  it('login refuses a bad or unknown server name', async () => {
    const res = await kit.app.inject({ method: 'POST', url: `/api/mcp/${encodeURIComponent('a;calc')}/login`, payload: {} });
    assert.equal(res.statusCode, 400);
    const unknown = await kit.app.inject({ method: 'POST', url: '/api/mcp/nobody/login', payload: {} });
    assert.equal(unknown.statusCode, 404);
  });
});
