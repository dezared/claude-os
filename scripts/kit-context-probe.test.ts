import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextDelta } from './kit-context-probe.ts';

test('contextDelta is the growth of the starting context', () => {
  assert.equal(contextDelta(12000, 13500), 1500);
  assert.equal(contextDelta(12000, 11800), -200);
  assert.equal(contextDelta(0, 0), 0);
});
