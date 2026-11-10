import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTouchpoints, realFs, touchpointGaps, type Touchpoint } from './check-touchpoints.ts';

function memFs(files: Record<string, string>) {
  return {
    read: (path: string) => files[path] ?? null,
    list: (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  };
}

const microtasks: Touchpoint = {
  name: 'microtasks',
  source: 'server/tools/microtasks.ts',
  memberRegex: "^  '([\\w-]+)': '(?:owner|service)',$",
  fileExists: 'root/microtasks/{member}.md',
  reverseDir: 'root/microtasks',
};
const routes = (...keys: string[]) => `export const MICROTASK_ROUTES = {\n${keys.map((k) => `  '${k}': 'owner',\n`).join('')}};\n`;

test('red on a microtask key without a file', () => {
  const fs = memFs({ 'server/tools/microtasks.ts': routes('a', 'x'), 'root/microtasks/a.md': '' });
  const gaps = touchpointGaps([microtasks], fs);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /\bx\b/);
});

test('red on a file without a key', () => {
  const fs = memFs({ 'server/tools/microtasks.ts': routes('a'), 'root/microtasks/a.md': '', 'root/microtasks/y.md': '' });
  const gaps = touchpointGaps([microtasks], fs);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /\by\b/);
});

test('red on a member missing from a registry', () => {
  const entry: Touchpoint = {
    name: 'plugin-permissions',
    source: 'shared/contract.ts',
    memberRegex: "^  '([\\w.]+)',$",
    registries: ['root/reference/plugins.md'],
  };
  const fs = memFs({ 'shared/contract.ts': "[\n  'files.read',\n  'files.write',\n]", 'root/reference/plugins.md': '- `files.read`' });
  const gaps = touchpointGaps([entry], fs);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /files\.write/);
  assert.match(gaps[0], /root\/reference\/plugins\.md/);
});

test('red when a widget type is missing from the reference', () => {
  const entry = readTouchpoints().find((t) => t.name === 'widget-types');
  assert.ok(entry, 'touchpoints.json has a widget-types entry');
  const widget = (type: string) => `  | { id: string; title: string; type: '${type}'; content?: string }\n`;
  const fs = memFs({ 'server/tools/widgets.ts': `type RawWidget = {} & (\n${widget('block')}${widget('gauge')});\n`, 'root/reference/widgets.md': '- `block`: text' });
  const gaps = touchpointGaps([entry], fs);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /\bgauge\b/);
  assert.match(gaps[0], /root\/reference\/widgets\.md/);
});

test('red when a member regex matches nothing', () => {
  const gaps = touchpointGaps([microtasks], memFs({ 'server/tools/microtasks.ts': 'export const MICROTASK_ROUTES = {};' }));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /no members/);
});

test('green on the real repo', () => {
  assert.deepEqual(touchpointGaps(readTouchpoints(), realFs), []);
});
