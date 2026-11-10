import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bootstrapConfig } from './defaults.ts';

const FILES = ['settings.json', 'widgets.json', 'actions.json', 'project-icons/icons.json'];

function dirs(defaults: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'defaults-'));
  const def = join(root, 'defaults');
  const cfg = join(root, 'config');
  for (const [name, value] of Object.entries(defaults)) put(def, name, value);
  return { root, def, cfg };
}

function put(dir: string, name: string, value: unknown) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

test('copies missing files', () => {
  const { root, def, cfg } = dirs({ 'settings.json': {}, 'widgets.json': [], 'actions.json': [], 'project-icons/icons.json': {} });
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual([...report.copied].sort(), [...FILES].sort());
  for (const name of FILES) assert.ok(existsSync(join(cfg, name)), name);
  assert.deepEqual(report.keysAdded, []);
  assert.deepEqual(report.skippedInvalid, []);
  rmSync(root, { recursive: true });
});

test('never overwrites existing values', () => {
  const { root, def, cfg } = dirs({ 'settings.json': { universe: { x: 2, y: 3 } } });
  put(cfg, 'settings.json', { universe: { x: 1 } });
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual(read(cfg, 'settings.json'), { universe: { x: 1, y: 3 } });
  assert.deepEqual(report.keysAdded, ['universe.y']);
  assert.deepEqual(report.copied, []);
  rmSync(root, { recursive: true });
});

test('appends a new shipped record once', () => {
  const { root, def, cfg } = dirs({ 'widgets.json': [{ id: 'a' }, { id: 'b' }] });
  put(cfg, 'widgets.json', [{ id: 'a', title: 'mine' }]);
  put(cfg, '.shipped-seen.json', { 'widgets.json': ['a'] });
  const first = bootstrapConfig(def, cfg);
  assert.deepEqual(read(cfg, 'widgets.json'), [{ id: 'a', title: 'mine' }, { id: 'b' }]);
  assert.deepEqual(first.appended, { 'widgets.json': ['b'] });
  const second = bootstrapConfig(def, cfg);
  assert.deepEqual(read(cfg, 'widgets.json'), [{ id: 'a', title: 'mine' }, { id: 'b' }]);
  assert.deepEqual(second.appended, {});
  rmSync(root, { recursive: true });
});

test('does not re-add a deleted record', () => {
  const { root, def, cfg } = dirs({ 'widgets.json': [{ id: 'a' }] });
  put(cfg, 'widgets.json', []);
  put(cfg, '.shipped-seen.json', { 'widgets.json': ['a'] });
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual(read(cfg, 'widgets.json'), []);
  assert.deepEqual(report.appended, {});
  rmSync(root, { recursive: true });
});

test('bootstrap keeps an invalid user file untouched', () => {
  const { root, def, cfg } = dirs({ 'settings.json': { universe: { y: 3 } } });
  put(cfg, 'settings.json', '{oops');
  const report = bootstrapConfig(def, cfg);
  assert.equal(readFileSync(join(cfg, 'settings.json'), 'utf8'), '{oops');
  assert.deepEqual(report.skippedInvalid, ['settings.json']);
  assert.deepEqual(report.keysAdded, []);
  rmSync(root, { recursive: true });
});

test('first run marks the ids the install already has as seen', () => {
  const { root, def, cfg } = dirs({ 'widgets.json': [{ id: 'a' }, { id: 'b' }] });
  put(cfg, 'widgets.json', [{ id: 'a', title: 'mine' }, { id: 'u' }]);
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual(report.appended, { 'widgets.json': ['b'] });
  assert.deepEqual([...read(cfg, '.shipped-seen.json')['widgets.json']].sort(), ['a', 'b', 'u']);
  rmSync(root, { recursive: true });
});

test('a corrupt seen file appends nothing and stays untouched', () => {
  const { root, def, cfg } = dirs({ 'widgets.json': [{ id: 'a' }, { id: 'b' }] });
  put(cfg, 'widgets.json', [{ id: 'a' }]);
  put(cfg, '.shipped-seen.json', '{oops');
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual(read(cfg, 'widgets.json'), [{ id: 'a' }]);
  assert.deepEqual(report.appended, {});
  assert.equal(readFileSync(join(cfg, '.shipped-seen.json'), 'utf8'), '{oops');
  assert.deepEqual(report.skippedInvalid, ['.shipped-seen.json']);
  rmSync(root, { recursive: true });
});

test('a broken shipped file is reported, the rest still lands', () => {
  const { root, def, cfg } = dirs({ 'actions.json': '{oops', 'settings.json': {} });
  const report = bootstrapConfig(def, cfg);
  assert.deepEqual(report.copied, ['settings.json']);
  assert.deepEqual(report.skippedInvalid, ['actions.json']);
  assert.ok(!existsSync(join(cfg, 'actions.json')));
  rmSync(root, { recursive: true });
});

test('the shipped defaults are what an empty config reads', () => {
  const shipped = join(import.meta.dirname, '..', 'defaults');
  assert.deepEqual(read(shipped, 'settings.json'), {});
  assert.deepEqual(read(shipped, 'widgets.json'), []);
  assert.deepEqual(read(shipped, 'actions.json'), []);
  assert.deepEqual(read(shipped, 'project-icons/icons.json'), {});
});
