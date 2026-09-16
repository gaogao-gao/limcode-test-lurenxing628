const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const pinia = require('pinia');
const { reactive } = require('vue');

function fixture() {
  const requests = [], timers = [];
  const client = { modelProfiles: [], modelProfileScopeLinks: [] };
  const source = fs.readFileSync('webview/src/stores/useModelProfileStore.ts', 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { exports: module.exports, module, setTimeout: callback => timers.push(callback), require(name) {
    if (name === 'pinia') return pinia;
    if (name === './useClientStateStore') return { useClientStateStore: () => client };
    if (name === '@webview/transport') return { BridgeMessageType: { ModelProfileScopeSet: 'set', ModelProfileScopeClear: 'clear' }, bridge: { request(type, payload) {
      requests.push({ id: `request-${requests.length}`, type, payload: structuredClone(payload) });
      return requests.at(-1).id;
    } } };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  pinia.setActivePinia(pinia.createPinia());
  return { store: module.exports.useModelProfileStore(), requests, timers, client };
}
const selection = value => reactive({ providerConfigId: 'fixture', provider: 'openai-compatible', model: 'o3', thinkingOverride: { kind: 'openai-effort', value } });

test('思维保存只等待当前会话关联请求，无Proxy bridge，无全会话屏障', async () => {
  const f = fixture();
  f.store.setProfileForScope('conversation', 'a', selection('high'));
  let saved = false;
  const waiting = f.store.awaitSavedForScope('conversation', 'a').then(() => { saved = true; });
  await f.store.awaitSavedForScope('conversation', 'b');
  f.store.reconcileSnapshot('unrelated');
  await Promise.resolve();
  assert.equal(saved, false);
  assert.equal(f.requests[0].payload.thinkingOverride.value, 'high');
  f.store.reconcileSnapshot(f.requests[0].id);
  await waiting;
  assert.equal(saved, true);
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
});

test('失败与超时保留选择，不能伪称已保存；重试及撤销通过原authority通道', async () => {
  const f = fixture();
  f.store.setProfileForScope('conversation', 'a', selection('high'));
  f.store.rejectPending(f.requests[0].id, 'custom body conflict');
  assert.equal(f.store.localProfileFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  await assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /custom body conflict/);
  f.store.discardPending('conversation', 'a');
  assert.equal(f.requests.at(-1).payload.thinkingOverride, null);
  f.store.reconcileSnapshot(f.requests.at(-1).id);
  await f.store.awaitSavedForScope('conversation', 'a');
  f.store.setProfileForScope('conversation', 'a', selection('medium'));
  f.timers.at(-1)();
  assert.equal(f.store.localProfileFor('conversation', 'a').profile.thinkingOverride.value, 'medium');
  await assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /未确认保存/);
});

test('快速修改和切换会话时迟到旧确认不能清除最新选择', async () => {
  const f = fixture();
  f.store.setProfileForScope('conversation', 'a', selection('high'));
  const oldWait = assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /选择已更新/);
  f.store.setProfileForScope('conversation', 'a', selection('medium'));
  f.store.setProfileForScope('conversation', 'b', selection('low'));
  await oldWait;
  f.store.reconcileSnapshot(f.requests[0].id);
  assert.equal(f.store.pendingFor('conversation', 'a').profile.thinkingOverride.value, 'medium');
  f.store.reconcileSnapshot(f.requests[2].id);
  assert.ok(f.store.pendingFor('conversation', 'a'));
  f.store.reconcileSnapshot(f.requests[1].id);
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
});
