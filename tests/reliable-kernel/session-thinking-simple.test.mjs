import assert from 'node:assert/strict';
import test from 'node:test';

const { SessionThinkingReadCache } = await import('../../dist/extension/backend/reliableKernel/sessionThinkingReadCache.js');
const { childThinkingOverrideForSpawn } = await import('../../dist/extension/backend/reliableKernel/childThinkingInheritance.js');

test('read cache deduplicates same provider/model/authority/revision and latest result wins', async () => {
  const cache = new SessionThinkingReadCache();
  let reads = 0;
  const loader = () => { reads++; return new Promise(resolve => setTimeout(() => resolve({ model: 'same' }), 10)); };
  const first = cache.get({ providerConfigId: 'p', model: 'm', authorityId: 'a', revision: 'r' }, loader);
  const second = cache.get({ providerConfigId: 'p', model: 'm', authorityId: 'a', revision: 'r' }, loader);
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.deepEqual(await cache.get({ providerConfigId: 'p', model: 'm', authorityId: 'a', revision: 'r' }, loader), { model: 'same' });
  assert.equal(reads, 1);
});

test('child thinking override is explicit opt-in', () => {
  const current = { kind: 'openai-effort', value: 'high' };
  assert.deepEqual(childThinkingOverrideForSpawn({ inheritThinking: true, thinkingOverride: current }), current);
  assert.equal(childThinkingOverrideForSpawn({ inheritThinking: false, thinkingOverride: current }), undefined);
});
