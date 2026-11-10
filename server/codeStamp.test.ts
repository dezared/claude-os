import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newestCode } from './codeStamp.ts';

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'code-stamp-'));
  mkdirSync(join(dir, 'tools/fixtures'), { recursive: true });
  const touch = (name: string, at: number) => {
    writeFileSync(join(dir, name), '');
    utimesSync(join(dir, name), at, at);
  };
  return { dir, touch };
}

test('the newest running source file sets the stamp, in any folder', () => {
  const { dir, touch } = tree();
  touch('index.ts', 1000);
  touch('tools/git.ts', 2000);
  assert.equal(newestCode([dir]), 2000_000);
  rmSync(dir, { recursive: true });
});

test('tests, fixtures and other files do not make a server stale', () => {
  const { dir, touch } = tree();
  touch('index.ts', 1000);
  touch('index.test.ts', 5000);
  touch('tools/fixtures/fake.ts', 5000);
  touch('notes.md', 5000);
  assert.equal(newestCode([dir]), 1000_000);
  rmSync(dir, { recursive: true });
});

test('a missing folder counts as no code', () => {
  assert.equal(newestCode(['/nonexistent/claude-os-code']), 0);
});
