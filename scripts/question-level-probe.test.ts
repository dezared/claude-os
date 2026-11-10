import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBE_PROMPTS, probeVerdict } from './question-level-probe.ts';

test('probe verdict', () => {
  assert.deepEqual(PROBE_PROMPTS.map((p) => p.id), ['clear', 'ambiguous-reversible', 'ambiguous-irreversible']);
  const counts = {
    minimal: { clear: 0, 'ambiguous-reversible': 0, 'ambiguous-irreversible': 1 },
    balanced: { clear: 0, 'ambiguous-reversible': 1, 'ambiguous-irreversible': 1 },
    thorough: { clear: 1, 'ambiguous-reversible': 1, 'ambiguous-irreversible': 2 },
  };
  assert.deepEqual(probeVerdict(counts), []);
  assert.equal(probeVerdict({ ...counts, minimal: { ...counts.minimal, clear: 1 } }).length, 1);
});
