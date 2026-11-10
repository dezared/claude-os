import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionDenial } from './questionCap.ts';

test('caps per level', () => {
  assert.equal(questionDenial('minimal', 1), 'Question level minimal: decide, state the assumption, continue.');
  assert.equal(questionDenial('minimal', 0), null);
  assert.equal(questionDenial('balanced', 1), null);
  assert.notEqual(questionDenial('balanced', 2), null);
  assert.equal(questionDenial('thorough', 50), null);
  assert.equal(questionDenial(null, 9), null);
});
