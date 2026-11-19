// The shipped Learn plugin's MCP server, spoken to over stdio as Claude Code does.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { validateManifest } from './osPlugins.ts';

const PLUGIN = join(import.meta.dirname, '..', '..', 'plugins', 'learn');
let dir: string;
let proc: ChildProcess;
let next = 1;
const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-mcp-'));
  proc = spawn(process.execPath, [join(PLUGIN, 'mcp', 'server.mjs')], { env: { ...process.env, LEARN_DATA: join(dir, 'data'), HOME: dir, USERPROFILE: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
});
afterEach(() => {
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

function rpc(method: string, params?: unknown) {
  const id = next++;
  return new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
    waiting.set(id, resolve);
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function tool(name: string, args: object) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  const r = result as { content: { text: string }[]; isError?: boolean };
  return { error: !!r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) as Record<string, unknown> };
}

const NODES = [{ title: 'Toolchain', summary: 'go run, go test' }, { title: 'Types and structs' }, { title: 'Errors' }];

describe('learn mcp server', () => {
  it('the manifest validates', () => {
    assert.deepEqual(validateManifest('learn', PLUGIN).errors, []);
  });

  it('answers the handshake and lists its tools', async () => {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result as { serverInfo: { name: string } };
    assert.equal(init.serverInfo.name, 'learn');
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = (await rpc('tools/list')).result as { tools: { name: string }[] };
    assert.deepEqual(tools.map((t) => t.name), ['learn_list_tracks', 'learn_get_track', 'learn_create_track', 'learn_update_roadmap', 'learn_save_lesson', 'learn_get_lesson', 'learn_record_grade', 'learn_save_material', 'learn_read_material']);
    assert.match((await rpc('nope')).error!.message, /no method/);
  });

  it('creates a track with a work folder, saves a lesson, grades practice and keeps node ids across a roadmap change', async () => {
    const track = (await tool('learn_create_track', { title: 'Go для PHP', goal: 'Write services in Go', nodes: NODES })).json();
    assert.equal(track.id, 'go-php');
    assert.ok(existsSync(join(dir, 'learn', 'go-php')));
    const ids = (track.nodes as { id: string }[]).map((n) => n.id);
    assert.deepEqual(ids, ['toolchain', 'types-and-structs', 'errors']);

    const saved = (await tool('learn_save_lesson', {
      track: 'go-php', node: 'toolchain', title: 'Toolchain', minutes: 20, html: '<h2>Why</h2><p onclick="x()">Hi</p>',
      quiz: [{ question: 'Run tests?', options: ['go test', 'go run'], answer: 0, explain: 'go test runs *_test.go' }],
      videos: [{ title: 'Go in 100 seconds', url: 'https://www.youtube.com/results?search_query=go+in+100+seconds' }],
      practice: { task: 'Write FormatAmount', hint: 'int64 cents' },
    })).json();
    assert.equal(saved.quiz, 1);
    assert.equal((saved.warnings as string[]).length, 1, 'the inline handler is reported');
    const lesson = JSON.parse(readFileSync(join(dir, 'data/tracks/go-php/lessons/toolchain.json'), 'utf8')) as { quiz: unknown[]; practice: { hint: string } };
    assert.equal(lesson.practice.hint, 'int64 cents');

    const grade = (await tool('learn_record_grade', { track: 'go-php', node: 'types-and-structs', score: 85, feedback: 'Good' })).json();
    assert.equal(grade.passed, true);

    const moved = (await tool('learn_update_roadmap', { track: 'go-php', nodes: [{ id: 'errors' }, { title: 'Interfaces' }, { id: 'toolchain' }] })).json();
    assert.deepEqual((moved.nodes as { id: string; title: string }[]).map((n) => [n.id, n.title]), [['errors', 'Errors'], ['interfaces', 'Interfaces'], ['toolchain', 'Toolchain']]);

    writeFileSync(join(dir, 'data/tracks/go-php/progress.json'), JSON.stringify({ done: { toolchain: 1 }, attempts: [{ node: 'toolchain', at: 1, score: 1, total: 1 }] }));
    const got = (await tool('learn_get_track', { track: 'go-php' })).json();
    const nodes = got.nodes as { id: string; done: boolean; hasLesson: boolean }[];
    assert.deepEqual(nodes.find((n) => n.id === 'toolchain'), { ...nodes.find((n) => n.id === 'toolchain'), done: true, hasLesson: true });
    assert.equal((got.recentQuizAttempts as unknown[]).length, 1);
    const [listed] = (await tool('learn_list_tracks', {})).json() as unknown as { next: string; done: number }[];
    assert.deepEqual([listed.next, listed.done], ['errors', 1]);
  });

  it('a course carries its materials and exercises: a stored file set with the command that checks it', async () => {
    await tool('learn_create_track', { id: 'go', title: 'Go', goal: 'g', nodes: NODES });
    const saved = (await tool('learn_save_material', { track: 'go', title: 'Program', kind: 'markdown', content: '# 12 lessons' })).json();
    assert.equal(saved.id, 'program');
    await tool('learn_save_material', { track: 'go', id: 'program', title: 'Program v2', kind: 'markdown', content: '# 13 lessons' });
    const got = (await tool('learn_get_track', { track: 'go' })).json();
    assert.deepEqual(got.materials, [{ id: 'program', title: 'Program v2', kind: 'markdown', chars: 12 }]);
    assert.equal((await tool('learn_read_material', { track: 'go', material: 'program' })).json().content, '# 13 lessons');

    await tool('learn_save_lesson', {
      track: 'go', node: 'toolchain', title: 'Toolchain', html: '<p>x</p>',
      practice: { task: 'FormatAmount', check: 'go test ./...', files: [{ path: 'go.mod', content: 'module gocourse/01\n' }, { path: 'money/money_test.go', content: 'package money\n' }] },
    });
    const lesson = JSON.parse(readFileSync(join(dir, 'data/tracks/go/lessons/toolchain.json'), 'utf8')) as { practice: { check: string; files: { path: string }[] } };
    assert.equal(lesson.practice.check, 'go test ./...');
    assert.deepEqual(lesson.practice.files.map((f) => f.path), ['go.mod', 'money/money_test.go']);
    assert.equal(((await tool('learn_get_lesson', { track: 'go', node: 'toolchain' })).json().practice as { files: unknown[] }).files.length, 2);

    const bad: [string, object, RegExp][] = [
      ['learn_save_material', { track: 'go', title: 't', kind: 'pdf', content: 'x' }, /kind must be one of/],
      ['learn_read_material', { track: 'go', material: 'nope' }, /no material nope/],
      ['learn_get_lesson', { track: 'go', node: 'errors' }, /no lesson for errors/],
      ['learn_save_lesson', { track: 'go', node: 'errors', title: 't', html: '<p>x</p>', practice: { task: 't', files: [{ path: '../x.go', content: 'x' }] } }, /relative path inside/],
      ['learn_save_lesson', { track: 'go', node: 'errors', title: 't', html: '<p>x</p>', practice: { task: 't', files: [{ path: '/etc/x', content: 'x' }] } }, /relative path inside/],
    ];
    for (const [name, args, re] of bad) {
      const r = await tool(name, args);
      assert.equal(r.error, true, name);
      assert.match(r.text, re);
    }
  });

  it('rejects bad input with a message Claude can act on', async () => {
    await tool('learn_create_track', { title: 'Go', goal: 'g', nodes: NODES });
    const cases: [string, object, RegExp][] = [
      ['learn_create_track', { title: 'x', goal: 'g', nodes: [] }, /nodes must be a non-empty list/],
      ['learn_get_track', { track: '../etc' }, /bad track id/],
      ['learn_save_lesson', { track: 'go', node: 'missing', title: 't', html: '<p>x</p>' }, /learn_update_roadmap first/],
      ['learn_save_lesson', { track: 'go', node: 'errors', title: 't', html: '<p>x</p>', quiz: [{ question: 'q', options: ['a', 'b'], answer: 5 }] }, /answer must be the index/],
      ['learn_save_lesson', { track: 'go', node: 'errors', title: 't', html: '<p>x</p>', videos: [{ title: 'v', url: 'http://x' }] }, /https/],
      ['learn_record_grade', { track: 'go', node: 'errors', score: 140, feedback: 'f' }, /0 to 100/],
      ['learn_update_roadmap', { track: 'go', nodes: [{ title: 'x', status: 'later' }] }, /status must be/],
      ['learn_create_track', { title: 'Etc', goal: 'g', nodes: NODES, workdir: '/etc/learn-here' }, /workdir must be a folder inside/],
      ['learn_create_track', { title: 'Up', goal: 'g', nodes: NODES, workdir: '../outside' }, /workdir must be a folder inside/],
      ['learn_create_track', { title: 'Same', goal: 'g', nodes: NODES, workdir: join(dir, 'learn') }, /workdir must be a folder inside/],
    ];
    for (const [name, args, re] of cases) {
      const r = await tool(name, args);
      assert.equal(r.error, true, name);
      assert.match(r.text, re);
    }
    assert.equal(existsSync(join(dir, 'outside')), false, 'nothing made outside ~/learn');
    const inside = (await tool('learn_create_track', { title: 'Rust', goal: 'g', nodes: NODES, workdir: join(dir, 'learn', 'rust-work') })).json();
    assert.equal(inside.workdir, join(dir, 'learn', 'rust-work'));
    assert.ok(existsSync(join(dir, 'learn', 'rust-work')));
  });
});
