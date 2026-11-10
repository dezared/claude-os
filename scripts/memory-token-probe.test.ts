import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareProbes, memorySize, type Probe } from './memory-token-probe.ts';

test('memorySize counts lines and bytes', () => {
  assert.deepEqual(memorySize('a\nbb\n'), { lines: 2, bytes: 5 });
  assert.deepEqual(memorySize(''), { lines: 0, bytes: 0 });
});

test('compare shows per-project deltas and flags growth', () => {
  const a: Probe = {
    label: 'before',
    projects: {
      alpha: { tokens: 1000, lines: 10, bytes: 400 },
      beta: { tokens: 500, lines: 5, bytes: 200 },
    },
  };
  const b: Probe = {
    label: 'after',
    projects: {
      alpha: { tokens: 1200, lines: 12, bytes: 480 },
      beta: { tokens: 300, lines: 3, bytes: 120 },
    },
  };
  const lines = compareProbes(a, b).split('\n');
  const alpha = lines.find((l) => l.startsWith('alpha'))!;
  const beta = lines.find((l) => l.startsWith('beta'))!;
  assert.match(alpha, /\+200/);
  assert.match(alpha, /GREW/);
  assert.match(beta, /-200/);
  assert.doesNotMatch(beta, /GREW/);
});
