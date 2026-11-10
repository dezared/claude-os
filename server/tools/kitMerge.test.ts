import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { KitLockEntry } from '../../shared/projectKit.ts';
import { sha256 as sha } from '../memory/util.ts';
import { decideFile, mergeThree, readSnapshot, saveSnapshot, snapshotPath } from './kitMerge.ts';
import { mergeGitignore, mergeSettings, unmergeGitignore, unmergeSettings } from './kitSettings.ts';

const OLD = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
const NEW = 'one\ntwo\nthree\nfour\nfive\nsix\nseven (kit v2)\n';
const EDITED = 'one (mine)\ntwo\nthree\nfour\nfive\nsix\nseven\n';
const CLASH = 'one\ntwo\nthree\nfour\nfive\nsix\nseven (mine)\n';
const entry = (wrote: string, render = wrote): KitLockEntry => ({ wrote: sha(wrote), render: sha(render) });

describe('decideFile', () => {
  for (const owner of ['kit', 'seed'] as const) {
    it(`${owner}: not in the lock and absent is added`, () => {
      assert.deepEqual(decideFile({ owner, lock: null, disk: null, render: NEW, base: null }), { action: 'add', content: NEW, reason: null });
    });
    it(`${owner}: not in the lock and present is kept`, () => {
      assert.deepEqual(decideFile({ owner, lock: null, disk: EDITED, render: NEW, base: null }), { action: 'keep', content: null, reason: 'exists and is not the kit\'s' });
    });
    it(`${owner}: in the lock and absent is skipped forever`, () => {
      assert.deepEqual(decideFile({ owner, lock: entry(OLD), disk: null, render: NEW, base: OLD }), { action: 'skip', content: null, reason: 'deleted by the user' });
    });
  }

  it('seed: in the lock and present is never touched', () => {
    assert.equal(decideFile({ owner: 'seed', lock: entry(OLD), disk: EDITED, render: NEW, base: OLD }), null);
  });

  it('kit: the same render is nothing to do, edited or not', () => {
    assert.equal(decideFile({ owner: 'kit', lock: entry(NEW), disk: NEW, render: NEW, base: null }), null);
    assert.equal(decideFile({ owner: 'kit', lock: entry(NEW), disk: EDITED, render: NEW, base: null }), null);
  });

  it('kit: an unedited file is replaced by the new render', () => {
    assert.deepEqual(decideFile({ owner: 'kit', lock: entry(OLD), disk: OLD, render: NEW, base: null }), { action: 'update', content: NEW, reason: null });
  });

  it('kit: an edited file with a base snapshot is merged, or flagged on a conflict', () => {
    const clean = decideFile({ owner: 'kit', lock: entry(OLD), disk: EDITED, render: NEW, base: OLD });
    assert.deepEqual(clean, { action: 'merge', content: 'one (mine)\ntwo\nthree\nfour\nfive\nsix\nseven (kit v2)\n', reason: null });
    const clash = decideFile({ owner: 'kit', lock: entry(OLD), disk: CLASH, render: NEW, base: OLD });
    assert.equal(clash?.action, 'needs-merge');
    assert.equal(clash?.content, null);
    assert.ok(clash?.reason);
  });

  it('edited file without a base snapshot needs a merge', () => {
    // A teammate's checkout: the lock is committed, the snapshot lives on another machine.
    assert.deepEqual(decideFile({ owner: 'kit', lock: entry(OLD), disk: EDITED, render: NEW, base: null }), { action: 'needs-merge', content: null, reason: 'no base snapshot on this machine' });
  });

  it('re-applying after a clean merge is empty', () => {
    const merged = decideFile({ owner: 'kit', lock: entry(OLD), disk: EDITED, render: NEW, base: OLD });
    assert.equal(merged?.action, 'merge');
    const lock = { wrote: sha(merged!.content!), render: sha(NEW) };
    assert.equal(decideFile({ owner: 'kit', lock, disk: merged!.content, render: NEW, base: NEW }), null);
  });
});

describe('mergeThree', () => {
  it('real git merge-file merges a non-overlapping edit and flags an overlapping one', () => {
    assert.deepEqual(mergeThree(EDITED, OLD, NEW), { clean: true, content: 'one (mine)\ntwo\nthree\nfour\nfive\nsix\nseven (kit v2)\n' });
    const clash = mergeThree(CLASH, OLD, NEW);
    assert.equal(clash.clean, false);
    assert.match(clash.content, /<<<<<<< /);
  });
});

describe('snapshots', () => {
  const data = mkdtempSync(join(tmpdir(), 'kit-snap-'));
  after(() => rmSync(data, { recursive: true, force: true }));

  it('are content addressed per kit version', () => {
    assert.equal(snapshotPath(data, '1.0.0', sha(OLD)), join(data, 'project-kit', '1.0.0', sha(OLD)));
    saveSnapshot(data, '1.0.0', OLD);
    assert.equal(readSnapshot(data, '1.0.0', sha(OLD)), OLD);
    assert.equal(readSnapshot(data, '1.1.0', sha(OLD)), null);
    assert.equal(readSnapshot(data, '1.0.0', sha(NEW)), null);
  });
});

const HOOK = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/kit/hooks/stop-gate.mjs"' };
const KIT = {
  file: '.claude/settings.json',
  hooks: { Stop: [{ hooks: [HOOK] }] },
  allow: ['Bash(npm run test*)', 'Bash(git status*)'],
  deny: ['Edit(./.claude/kit/**)'],
  ask: ['Bash(git push*)'],
};
const USER_ENTRY = { hooks: [{ type: 'command', command: 'say done' }] };
const USER = `${JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [USER_ENTRY] } }, null, 2)}\n`;

function merged(current: string | null, prev: Parameters<typeof mergeSettings>[2] = null) {
  const out = mergeSettings(current, KIT, prev);
  if ('invalid' in out) throw new Error(out.invalid);
  return out;
}

describe('settings', () => {
  it('invalid settings json is skipped with a reason', () => {
    const out = mergeSettings('{', KIT, null);
    assert.ok('invalid' in out);
    assert.match(out.invalid, /not valid JSON/);
    assert.ok('invalid' in mergeSettings('[]', KIT, null));
  });

  it('settings keep the user\'s keys and order', () => {
    const first = merged(USER);
    const json = JSON.parse(first.content);
    assert.deepEqual(Object.keys(json), ['model', 'permissions', 'hooks']);
    assert.deepEqual(json.hooks.Stop, [USER_ENTRY, { hooks: [HOOK] }]);
    assert.deepEqual(json.permissions.allow, ['Bash(ls)', 'Bash(npm run test*)', 'Bash(git status*)']);
    assert.deepEqual(json.permissions.deny, ['Edit(./.claude/kit/**)']);
    assert.deepEqual(json.permissions.ask, ['Bash(git push*)']);
    assert.deepEqual(first.added, { file: '.claude/settings.json', allow: KIT.allow, deny: KIT.deny, ask: KIT.ask, hooks: [HOOK.command] });
    const again = merged(first.content, first.added);
    assert.equal(again.content, first.content);
    assert.deepEqual(again.added, first.added);
  });

  it('kit hook entries are replaced in place and permissions the user had are not claimed', () => {
    const old = { hooks: [{ type: 'command', command: 'node .claude/kit/hooks/old-stop.mjs' }] };
    const user = JSON.stringify({ hooks: { Stop: [old, USER_ENTRY] }, permissions: { allow: ['Bash(git status*)'] } });
    const out = merged(user);
    const json = JSON.parse(out.content);
    assert.deepEqual(json.hooks.Stop, [{ hooks: [HOOK] }, USER_ENTRY]);
    assert.deepEqual(json.permissions.allow, ['Bash(git status*)', 'Bash(npm run test*)']);
    assert.deepEqual(out.added.allow, ['Bash(npm run test*)']);
  });

  it('a missing settings file is created', () => {
    const json = JSON.parse(merged(null).content);
    assert.deepEqual(Object.keys(json), ['permissions', 'hooks']);
  });

  it('remove takes only what the kit added', () => {
    const first = merged(USER);
    const back = unmergeSettings(first.content, first.added);
    assert.equal(back, USER);
    const fresh = merged(null);
    assert.equal(unmergeSettings(fresh.content, fresh.added), '{}\n');
  });
});

describe('gitignore', () => {
  it('gitignore block is replaced, not duplicated', () => {
    const user = 'node_modules/\n';
    const once = mergeGitignore(user, 'docs');
    assert.equal(once, 'node_modules/\n\n# claude-os-kit:start\nCLAUDE.local.md\n.claude/settings.local.json\ndocs/handoff/\n# claude-os-kit:end\n');
    assert.equal(mergeGitignore(once, 'docs'), once);
    const moved = mergeGitignore(`${once}dist/\n`, 'dev-docs');
    assert.equal(moved.match(/claude-os-kit:start/g)?.length, 1);
    assert.match(moved, /dev-docs\/handoff\/\n# claude-os-kit:end\ndist\/\n$/);
    assert.equal(unmergeGitignore(once), user);
    assert.equal(mergeGitignore(null, 'docs'), '# claude-os-kit:start\nCLAUDE.local.md\n.claude/settings.local.json\ndocs/handoff/\n# claude-os-kit:end\n');
    assert.equal(unmergeGitignore(mergeGitignore(null, 'docs')), '');
  });
});
