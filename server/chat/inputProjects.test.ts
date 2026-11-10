// Paths from another system, attached file names, the ui_action tool's input and the structure of projects. Pure code.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Project } from '../../shared/contract.ts';
import { projectParents, projectTree, wouldLoop } from '../../shared/projectTree.ts';
import { projectPatchProblem } from '../journal/projects.ts';
import { toServerPath, withServerPaths } from '../tools/platform.ts';
import { buildMessage } from './files.ts';
import { localizeAttachedFiles } from '../../web/src/lib/serverLines.ts';
import { uiCommand, uiTool } from './rootMcp.ts';

const project = (key: string, root: string, extra: Partial<Project> = {}): Project => ({ key, name: key, root, misc: false, sessionCount: 0, liveCount: 0, lastActivity: null, memoryCount: 0, memoryConnected: false, memoryDrift: 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false, ...extra });

describe('paths from the Windows side', () => {
  it('turn into what a server in WSL opens', () => {
    assert.equal(toServerPath('C:\\Users\\p\\a b.txt', 'wsl'), '/mnt/c/Users/p/a b.txt');
    assert.equal(toServerPath('D:/x/y.png', 'wsl'), '/mnt/d/x/y.png');
    assert.equal(toServerPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\p\\a.ts', 'wsl'), '/home/p/a.ts');
    assert.equal(toServerPath('\\\\wsl$\\Ubuntu\\home\\p', 'wsl'), '/home/p');
  });

  it('stay as they are where they already are real, and on Linux and Mac', () => {
    for (const kind of ['windows', 'linux', 'mac'] as const) {
      assert.equal(toServerPath('C:\\a\\b.txt', kind), 'C:\\a\\b.txt');
      assert.equal(withServerPaths('см. "C:\\a b\\c.txt"', kind), 'см. "C:\\a b\\c.txt"');
    }
  });

  it('are found in a message, quoted or bare; the rest of the text stays', () => {
    assert.equal(withServerPaths('посмотри C:\\Users\\p\\a.txt и скажи', 'wsl'), 'посмотри /mnt/c/Users/p/a.txt и скажи');
    assert.equal(withServerPaths('"C:\\Program Files\\x\\a.log"', 'wsl'), '"/mnt/c/Program Files/x/a.log"');
    assert.equal(withServerPaths('"C:\\Users\\p\\a.log"', 'wsl'), '/mnt/c/Users/p/a.log');
    assert.equal(withServerPaths('время 12:30, адрес http://c:/x и /home/p/a.ts', 'wsl'), 'время 12:30, адрес http://c:/x и /home/p/a.ts');
  });
});

describe('an attached file', () => {
  const attach = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-attach-'));
    const m = buildMessage({ text: '', attachments: [{ name, mediaType: 'application/pdf', base64: 'eA==' }] }, dir);
    const line = (m.blocks.find((b) => b.type === 'text') as { text: string }).text;
    return { line, saved: readdirSync(dir)[0], dir };
  };

  it('keeps its letters, loses what would break the path, and the message gives the path on this system', () => {
    const { line, saved, dir } = attach('Отчёт за год (финал).pdf');
    assert.match(saved, /^[0-9a-f]{8}-Отчёт_за_год_финал_\.pdf$/);
    assert.equal(line, `Attached file: ${join(dir, saved)}`);
    const shown = (text: string) => localizeAttachedFiles(text, (path) => `<${path}>`);
    assert.equal(shown(`hi\n${line}`), `hi\n<${join(dir, saved)}>`, 'the UI renders the line in its own language');
    assert.equal(shown('Приложен файл: /a.pdf'), '</a.pdf>', 'older history too');
  });

  it('never leaves the folder, whichever separators the name has', () => {
    for (const name of ['..\\..\\evil.pdf', '../../evil.pdf', 'C:\\x\\evil.pdf']) assert.match(attach(name).saved, /^[0-9a-f]{8}-evil\.pdf$/);
    assert.match(attach('...').saved, /^[0-9a-f]{8}-file$/);
  });
});

describe('ui_action', () => {
  const projects = [{ key: 'alpha' }];

  it('makes a command of what it was asked', () => {
    assert.deepEqual(uiCommand({ action: 'notify', kind: 'done', text: ' готово ' }, projects), { action: 'notify', kind: 'done', text: 'готово' });
    assert.deepEqual(uiCommand({ action: 'notify', kind: 'question' }, projects), { action: 'notify', kind: 'question', text: null });
    assert.deepEqual(uiCommand({ action: 'toast', text: 'x' }, projects), { action: 'toast', text: 'x' });
    assert.deepEqual(uiCommand({ action: 'open', view: 'projects', project: 'alpha' }, projects), { action: 'open', view: 'projects', project: 'alpha' });
  });

  it('reaches the browser in the name of the tab the session lives in; a bad call reaches nothing', async () => {
    const messages: unknown[] = [];
    const ctx = { journal: { listProjects: () => projects }, broadcast: (m: unknown) => messages.push(m) };
    const server = createSdkMcpServer({ name: 'claude-os', tools: [uiTool(ctx as never, 'tab-7')] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    assert.equal((await client.callTool({ name: 'ui_action', arguments: { action: 'toast' } })).isError, true);
    assert.deepEqual(messages, []);
    await client.callTool({ name: 'ui_action', arguments: { action: 'notify', kind: 'done', text: 'готово' } });
    assert.deepEqual(messages, [{ t: 'ui', tabId: 'tab-7', command: { action: 'notify', kind: 'done', text: 'готово' } }]);
    await client.close();
  });

  it('says what is missing instead of doing half of it', () => {
    for (const input of [{ action: 'notify' }, { action: 'toast', text: ' ' }, { action: 'open' }, { action: 'open', view: 'projects', project: 'нет' }] as const) {
      assert.equal(typeof uiCommand(input, projects), 'string', JSON.stringify(input));
    }
  });
});

describe('structure of projects', () => {
  const list = [project('box', '/w/box', { folder: true }), project('a', '/w/box/a'), project('b', '/w/box/b'), project('top', '/w/top'), project('sub', '/w/top/sub')];

  it('folders on disk decide by default; a folder has no star, so the map skips it', () => {
    assert.deepEqual([...projectTree(list)].sort(), [['a', 'box'], ['b', 'box'], ['sub', 'top']]);
    assert.deepEqual([...projectParents(list)], [['sub', 'top']]);
  });

  it('a choice by hand wins: another parent, or the top level', () => {
    const moved = list.map((p) => (p.key === 'a' ? { ...p, parent: 'top' } : p.key === 'sub' ? { ...p, parent: '' } : p));
    assert.deepEqual([...projectParents(moved)], [['a', 'top']]);
  });

  it('a folder inside a project hands its projects to that project', () => {
    const nested = [project('top', '/w'), project('box', '/w/box', { folder: true }), project('a', '/w/box/a')];
    assert.deepEqual([...projectParents(nested)].sort(), [['a', 'top'], ['box', 'top']]);
  });

  it('no circle gets in, and one in the data does not hang anything', () => {
    assert.equal(wouldLoop(list, 'top', 'sub'), true);
    assert.equal(wouldLoop(list, 'a', 'top'), false);
    assert.equal(wouldLoop(list, 'box', 'a'), true);
    assert.match(projectPatchProblem(list, 'top', { parent: 'sub' }) ?? '', /inside/);
    const loop = [project('x', '/x', { parent: 'y' }), project('y', '/y', { parent: 'x' })];
    assert.ok(projectTree(loop).size < 2);
  });

  it('a wrong value is refused with the reason', () => {
    for (const patch of [{ name: ' ' }, { color: 'red' }, { color: '#12345' }, { parent: 'нет' }, { parent: 'a' }, { folder: 'да' as unknown as boolean }]) {
      assert.notEqual(projectPatchProblem(list, 'a', patch), null, JSON.stringify(patch));
    }
    for (const patch of [{ name: 'Имя' }, { color: '#AABBCC' }, { color: null }, { parent: '' }, { parent: null }, { parent: 'top' }, { folder: true }, { description: null }]) {
      assert.equal(projectPatchProblem(list, 'a', patch), null, JSON.stringify(patch));
    }
  });
});
