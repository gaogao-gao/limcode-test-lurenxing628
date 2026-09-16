const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const pinia = require('pinia');
const vue = require('vue');
const protocol = require('../../dist/extension/shared/protocol.js');
const { createEmptyClientState } = require('../../dist/extension/shared/clientStateSchema.js');

function fixture() {
  pinia.setActivePinia(pinia.createPinia());
  const requests = [], timers = [], listeners = new Map();
  const bridge = { request(type, payload) { const id = `request-${requests.length}`; requests.push({ id, type, payload: structuredClone(payload) }); return id; },
    on(type, callback) { listeners.set(type, callback); return () => listeners.delete(type); }, ready() {}, currentClientId() { return 'fixture-client'; } };
  let client, store;
  const noopStore = new Proxy({ records: {}, viewKind: 'test' }, { get(target, key) { return key in target ? target[key] : () => undefined; } });
  function load(file) {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { exports: module.exports, module, console, setTimeout: callback => timers.push(callback), require(name) {
      if (name === 'pinia') return pinia;
      if (name === 'vue') return { ...vue, onBeforeUnmount() {}, watch() { return () => undefined; } };
      if (name === '@shared/protocol') return protocol;
      if (name === '@shared/clientStateSchema') return { createEmptyClientState };
      if (name.endsWith('/useClientStateStore') || name === './useClientStateStore') return { useClientStateStore: () => client };
      if (name.endsWith('/useModelProfileStore')) return { useModelProfileStore: () => store };
      if (name === '@webview/transport') return { BridgeMessageType: protocol.BridgeMessageType, bridge };
      if (name.startsWith('@webview/stores/')) return { [name.split('/').at(-1)]: () => noopStore };
      throw new Error(`Unexpected dependency: ${name}`);
    } });
    return module.exports;
  }
  client = load('webview/src/stores/useClientStateStore.ts').useClientStateStore();
  store = load('webview/src/stores/useModelProfileStore.ts').useModelProfileStore();
  load('webview/src/composables/useBridgeBootstrap.ts').useBridgeBootstrap();
  const emit = (type, payload, correlationId) => listeners.get(type)?.({ payload, correlationId });
  const reply = (request, payload) => emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, payload, request.id);
  const read = (scopeId, payload = snapshot(scopeId, 'low', 1)) => { store.refreshScope('conversation', scopeId); reply(requests.at(-1), payload); };
  return { store, client, requests, timers, emit, reply, read };
}
const model = { providerConfigId: 'fixture', provider: 'openai-compatible', model: 'o3' };
function snapshot(scopeId, value, sequence, authorityId = 'root-a') {
  const profile = value === null ? undefined : { id: `profile-${scopeId}`, name: 'fixture', ...model, thinkingOverride: { kind: 'openai-effort', value } };
  return { scopeKind: 'conversation', scopeId, authorityId, sessionId: `session-${scopeId}-${authorityId}`, sequence, revision: `etag-${scopeId}-${sequence}`, outcome: 'observed', effectiveModel: model,
    ...(profile ? { profile, link: { id: `link-${scopeId}`, scopeKind: 'conversation', scopeId, modelProfileId: profile.id, role: 'active', createdAt: 1, updatedAt: sequence } } : {}) };
}
const choose = (f, scope, value) => f.store.setThinkingForScope(scope, vue.reactive(model), vue.reactive({ kind: 'openai-effort', value }));

test('真实bootstrap full payload迟到不覆盖已确认scope；只触发受控读并接受外部更新', () => {
  const f = fixture(); f.store.activateScope('conversation', 'a'); f.reply(f.requests.at(-1), snapshot('a', 'low', 1));
  choose(f, 'a', 'high'); const write = f.requests.at(-1);
  f.reply(write, { ...snapshot('a', 'high', 3), outcome: 'committed' });
  const old = snapshot('a', 'low', 1);
  f.emit(protocol.BridgeMessageType.ConfigurationSnapshot, { state: { ...createEmptyClientState(), modelProfiles: [old.profile], modelProfileScopeLinks: [old.link] } }, 'unrelated-old');
  assert.equal(f.client.modelProfiles[0].thinkingOverride.value, 'high');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  const refresh = f.requests.at(-1); assert.equal(refresh.type, protocol.BridgeMessageType.ModelProfileScopeRead);
  f.reply(refresh, snapshot('a', 'medium', 4));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'medium');
  const count = f.requests.length;
  f.emit(protocol.BridgeMessageType.ConfigurationSnapshot, { state: { ...createEmptyClientState(), modelProfiles: [old.profile], modelProfileScopeLinks: [old.link] } });
  assert.equal(f.requests.length, count, 'unchanged catalogs cannot create read loops');
});

test('scope序号独立、absence受保护，迟到scoped与陌生host payload不倒退', () => {
  const f = fixture(); f.read('a', snapshot('a', 'high', 10)); f.read('b', snapshot('b', 'low', 20));
  f.store.refreshScope('conversation', 'a'); const a = f.requests.at(-1); f.reply(a, snapshot('a', null, 11));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
  f.reply(a, snapshot('a', 'low', 9));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
  f.store.refreshScope('conversation', 'a'); const second = f.requests.at(-1); f.reply(second, snapshot('a', 'low', 30, 'retired-root'));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
});

test('timeout只scope-local保留不确定；放弃必须after原请求且绝不补偿write', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const write = f.requests.at(-1);
  f.timers.at(-1)();
  await assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /未确定/);
  await f.store.awaitSavedForScope('conversation', 'b');
  f.store.discardPending('conversation', 'a'); const read = f.requests.at(-1);
  assert.equal(read.type, protocol.BridgeMessageType.ModelProfileScopeRead);
  assert.equal(read.payload.afterRequestId, write.id);
  f.reply(read, { ...snapshot('a', 'low', 2), outcome: 'uncertain', revision: '', error: 'still pending' });
  assert.ok(f.store.pendingFor('conversation', 'a'));
  f.store.discardPending('conversation', 'a'); const settled = f.requests.at(-1);
  f.reply(settled, { ...snapshot('a', 'high', 3), afterRequestId: write.id });
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1, 'no compensation writes');
});

test('快速high→medium→reset只顺序提交最新草稿，用每次实际ack revision，不泄漏Proxy', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const first = f.requests.at(-1);
  choose(f, 'a', 'medium'); f.store.setThinkingForScope('a', model, null);
  assert.equal(f.requests.at(-1).id, first.id);
  f.reply(first, { ...snapshot('a', 'high', 2), outcome: 'committed' });
  const reset = f.requests.at(-1);
  assert.equal(reset.payload.operation, 'reset'); assert.equal(reset.payload.expectedRevision, 'etag-a-2');
  f.reply(first, { ...snapshot('a', 'high', 2), outcome: 'committed' });
  assert.equal(f.store.pendingFor('conversation', 'a').requestId, reset.id);
  f.reply(reset, { ...snapshot('a', null, 3), outcome: 'committed' });
  await f.store.awaitSavedForScope('conversation', 'a');
});

test('无thinking模型失败/超时仍保留通用恢复入口；实际值重读不自动重发', () => {
  const f = fixture(); f.read('a');
  f.store.setProfileForScope('conversation', 'a', { ...model, model: 'gpt-4o' }); const write = f.requests.at(-1);
  f.reply(write, { ...snapshot('a', 'low', 1), outcome: 'uncertain', revision: '', error: 'synthetic save failure' });
  assert.equal(f.store.pendingFor('conversation', 'a').profile.model, 'gpt-4o');
  f.store.retryPending('conversation', 'a'); const read = f.requests.at(-1);
  assert.equal(read.payload.afterRequestId, write.id);
  f.reply(read, { ...snapshot('a', 'high', 2), afterRequestId: write.id });
  assert.equal(f.store.pendingFor('conversation', 'a').status, 'draft');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
  const source = fs.readFileSync('webview/src/components/input/Composer.vue', 'utf8');
  assert.match(source, /<ModelProfileSaveStatus v-if="clientState.currentConversationId"/);
  assert.match(fs.readFileSync('webview/src/components/input/ModelProfileSaveStatus.vue', 'utf8'), /放弃草稿并读取已保存值/);
});

test('显式同root重建scope会话隔离未知旧操作，保留草稿且不永久锁发送', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const old = f.requests.at(-1);
  f.store.rejectPending(old.id, 'unknown request');
  f.store.refreshScope('conversation', 'a', { adoptRoot: true }); const refresh = f.requests.at(-1);
  assert.equal(refresh.payload.renewSession, true);
  f.reply(refresh, { ...snapshot('a', 'low', 2), sessionId: 'renewed-session' });
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.detachedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  await f.store.awaitSavedForScope('conversation', 'a');
  f.reply(old, { ...snapshot('a', 'high', 99), outcome: 'committed' });
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'low');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
});

test('显式新root基线保留旧草稿但不跨代提交；晚old ack/Hello/Error不恢复旧scope', () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const oldWrite = f.requests.at(-1);
  f.store.rejectPending(oldWrite.id, 'host restarted');
  f.store.refreshScope('conversation', 'a', { adoptRoot: true }); const adoption = f.requests.at(-1);
  f.reply(adoption, snapshot('a', null, 1, 'root-b'));
  assert.equal(f.store.authorityId, 'root-b'); assert.ok(f.store.detachedFor('conversation', 'a'));
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  f.reply(oldWrite, { ...snapshot('a', 'high', 99), outcome: 'committed' });
  f.store.rejectPending(oldWrite.id, 'late old error');
  assert.equal(f.store.confirmedFor('conversation', 'a').authorityId, 'root-b');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
});
