import assert from 'node:assert/strict';
import test from 'node:test';

const key = { providerConfigId: 'p', model: 'm', authorityId: 'a', revision: 'r' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('model read cache deduplicates in-flight work, caches values, and isolates every authority key', async () => {
  const { SessionThinkingReadCache } = await import('../../dist/extension/backend/reliableKernel/sessionThinkingReadCache.js');
  const cache = new SessionThinkingReadCache();
  let reads = 0;
  const gate = deferred();
  const load = () => { reads++; return gate.promise; };
  const first = cache.get(key, load), second = cache.get({ ...key }, load);
  assert.strictEqual(first, second);
  gate.resolve({ model: 'm' });
  await first;
  assert.deepEqual(await cache.get(key, load), { model: 'm' });
  assert.equal(reads, 1);
  for (const field of Object.keys(key)) await cache.get({ ...key, [field]: 'other' }, async () => { reads++; return {}; });
  assert.equal(reads, 5);
});

test('cache capacity never evicts pending work and duplicates it', async () => {
  const { SessionThinkingReadCache } = await import('../../dist/extension/backend/reliableKernel/sessionThinkingReadCache.js');
  const cache = new SessionThinkingReadCache(1);
  const gate = deferred();
  const first = cache.get(key, () => gate.promise);
  await cache.get({ ...key, model: 'other' }, async () => 'other');
  assert.strictEqual(cache.get(key, async () => 'duplicate'), first);
  gate.resolve('first');
  await first;
});

test('failed/cache-cleared reads never poison a retry or repopulate a retired authority', async () => {
  const { SessionThinkingReadCache } = await import('../../dist/extension/backend/reliableKernel/sessionThinkingReadCache.js');
  const cache = new SessionThinkingReadCache();
  await assert.rejects(cache.get(key, async () => { throw new Error('failed'); }), /failed/);
  const old = deferred();
  const pending = cache.get(key, () => old.promise);
  cache.clear();
  assert.equal(await cache.get(key, async () => 'new'), 'new');
  old.resolve('old'); await pending;
  assert.equal(await cache.get(key, async () => 'wrong'), 'new');
});
