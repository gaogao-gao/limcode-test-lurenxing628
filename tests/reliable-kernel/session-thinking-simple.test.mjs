import assert from 'node:assert/strict';
import test from 'node:test';

const { childThinkingOverrideForSpawn } = await import('../../dist/extension/backend/reliableKernel/childThinkingInheritance.js');

test('child thinking override is explicit opt-in', () => {
  const current = { kind: 'openai-effort', value: 'high' };
  assert.deepEqual(childThinkingOverrideForSpawn({ inheritThinking: true, thinkingOverride: current }), current);
  assert.equal(childThinkingOverrideForSpawn({ inheritThinking: false, thinkingOverride: current }), undefined);
});
