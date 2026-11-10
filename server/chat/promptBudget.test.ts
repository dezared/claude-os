// Every line of a product prompt is paid in every session of its kind: the budgets of the dev manifest, kept by a test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROMPT_LABELS, promptSources, QUESTION_LEVELS, sessionProfileBlock, type PromptKind } from './profile.ts';
import { sessionAppend } from './session.ts';

const REPO = join(import.meta.dirname, '../..');
const PATHS = { root: join(REPO, 'root'), service: join(REPO, 'service'), setup: join(REPO, 'setup') };
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

test('root prompt fits 4 KB', () => {
  const text = read('root/CLAUDE.md');
  assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} B`);
  assert.ok(text.trimEnd().split('\n').length <= 40, `${text.trimEnd().split('\n').length} lines`);
});

test('service prompt fits 2 KB', () => {
  const size = Buffer.byteLength(read('service/CLAUDE.md'));
  assert.ok(size <= 2048, `${size} B`);
});

test('work tab append fits 2 KB at every level', () => {
  for (const questionLevel of Object.keys(QUESTION_LEVELS)) {
    const ctx = { paths: PATHS, settings: { profile: () => ({ name: 'Ann', language: 'en', questionLevel, projectsDir: '/p' }) } };
    const append = sessionAppend({ profile: sessionProfileBlock(ctx as never, 'work'), note: null, noteRules: read('root/NOTE_RULES.md'), document: null });
    assert.ok(Buffer.byteLength(append) <= 2048, `${questionLevel}: ${Buffer.byteLength(append)} B`);
  }
});

test('every prompt label is named by a prompt', () => {
  const kinds: PromptKind[] = ['root', 'service', 'setup', 'work'];
  const sources = kinds.map((kind) => promptSources(PATHS as never, kind)).join('\n');
  assert.deepEqual(Object.keys(PROMPT_LABELS).filter((name) => !sources.includes(name)), []);
});
