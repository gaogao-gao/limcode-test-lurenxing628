import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });
const kernel = require('../../dist/extension/backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = require('../../dist/extension/backend/reliableKernel/childAgentCoordinator.js');
const { readFrozenTurnAuthority } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');
const { dryRunLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = require('../../dist/extension/backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { LlmEventType } = require('../../dist/extension/backend/world/modules/llm/events.js');

async function fixture(run, hooks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-session-thinking-runtime-'));
  let app, coordinator;
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'thinking-runtime', provider: 'openai-compatible', model: 'o3', models: [{ id: 'o3', name: 'o3' }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const agent = await configuration.mutations.createAgent({ name: 'synthetic', kind: 'custom' });
    const childAgent = await configuration.mutations.createAgent({ name: 'synthetic child', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['counter', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    const set = (conversationId, value) => configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: conversationId, providerConfigId: provider.id, provider: provider.provider, model: provider.model, thinkingOverride: value ? { kind: 'openai-effort', value } : null });
    const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    const requests = [], wires = [];
    let f;
    const frozen = async turnId => {
      const [row] = await list('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        let projected;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { projected = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(projected, { settings: { ...effective, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
        wires.push({ conversationId: request.conversationId, turnId: request.turnId, body: wire.body });
        if (hooks.send) return hooks.send(request, controls, f);
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
      } }; } },
      toolDispatcher: {
        definitions() { return ['counter', 'run_agent'].map(name => ({ name, description: 'synthetic', parameters: { type: 'object', properties: {} }, metadata: { readonly: true } })); },
        async dispatch(input) {
          if (input.toolName === 'run_agent') {
            const authority = await frozen(input.turnId);
            return coordinator.dispatch(input, undefined, { snapshotId: authority.snapshot.id, document: authority.document, toolConfig: { config: { maxChildAgentDepth: 3 } } });
          }
          await hooks.tool?.(f);
          const settled = await app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `counter:${input.toolCallId}` }, toolCallId: input.toolCallId, status: 'succeeded', detail: { count: 1 } });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      modelProfiles: { initializeConversation: ({ conversationId, model }) => configuration.mutations.initializeConversationModelProfile({ conversationId, ...model }) }
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'thinking-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'synthetic input' });
    f = { app, configuration, coordinator, provider, childAgent, set, save, input, requests, wires, list, frozen };
    await run(f);
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('review P1-1真实authority无覆盖Astra冻结raw body仍经过适配器清洗', async () => {
  await fixture(async f => {
    const astra = { ...f.provider, provider: 'openai-responses', model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra', name: 'Astra' }], generationConfig: {}, requestBody: { temperature: 0.7, top_logprobs: 5, include: ['message.output_text.logprobs'], custom_field: 'keep' } };
    await f.save('llmProviderConfigs', { configs: [astra] });
    const result = await f.app.agentLoop.runInput(f.input('astra-raw-no-override'));
    assert.equal(result.terminalStatus, 'completed');
    const body = f.wires[0].body;
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_logprobs, undefined);
    assert.ok(!body.include?.includes('message.output_text.logprobs'));
    assert.equal(body.custom_field, 'keep');
  });
});

test('review P2-4非法Claude覆盖只拒绝本次保存，原会话仍按默认发送', async () => {
  await fixture(async f => {
    const claude = { ...f.provider, provider: 'claude', model: 'claude-sonnet-4-5', models: [{ id: 'claude-sonnet-4-5', name: 'Claude' }], generationConfig: { maxOutputTokens: 8192, temperature: 0.7 } };
    await f.save('llmProviderConfigs', { configs: [claude] });
    const selection = { scopeKind: 'conversation', scopeId: 'parent', providerConfigId: claude.id, provider: claude.provider, model: claude.model };
    await assert.rejects(f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: { kind: 'claude-budget', tokens: 2048 } }), /采样/);
    await f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: null });
    assert.equal((await f.app.agentLoop.runInput(f.input('claude-after-rejected-save'))).terminalStatus, 'completed');
    assert.equal(f.wires[0].body.temperature, 0.7);
    assert.equal(f.wires[0].body.thinking, undefined);
    await f.save('llmProviderConfigs', { configs: [{ ...claude, generationConfig: { maxOutputTokens: 8192, topP: .95 } }] });
    await f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: { kind: 'claude-budget', tokens: 2048 } });
    assert.equal((await f.app.agentLoop.runInput(f.input('claude-legal-sampling'))).terminalStatus, 'completed');
    assert.equal(f.wires[1].body.top_p, .95);
    assert.equal(f.wires[1].body.thinking.budget_tokens, 2048);
  });
});

test('子 Agent 自有另一渠道和协议优先，父 OpenAI effort 不写入子 Gemini wire', async () => {
  await fixture(async f => {
    const childProvider = { ...f.provider, id: 'child-gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'synthetic Gemini' }], generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } } };
    await f.save('llmProviderConfigs', { configs: [f.provider, childProvider] });
    await f.configuration.mutations.setModelProfile({ scopeKind: 'agent', scopeId: f.childAgent.id, providerConfigId: childProvider.id, provider: childProvider.provider, model: childProvider.model });
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('cross-provider-child'));
    await f.coordinator.waitForIdle();
    const children = f.wires.filter(w => w.conversationId !== 'parent');
    assert.ok(children.length);
    for (const child of children) {
      assert.equal(child.body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.equal(child.body.reasoning_effort, undefined);
      assert.equal(child.body.generationConfig.thinkingConfig.thinkingLevel, undefined);
    }
  }, { async send(request, controls, f) {
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: f.requests.length === 1 ? [{ id: 'cross-child', functionCall: { name: 'run_agent', args: { prompt: 'synthetic cross-provider task' } } }] : [{ text: 'done' }] } });
  } });
});

test('首次/工具新请求/下一用户请求用新覆盖；旧请求 replay 保持原快照', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    const result = await f.app.agentLoop.runInput(f.input('first'));
    assert.equal(result.terminalStatus, 'completed');
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'medium']);
    const replay = await f.app.modelProvider.replay(f.requests[0].modelRequestId);
    assert.equal(replay.authoritySnapshot.model.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.deepEqual(replay.settingsSnapshot, f.requests[0].settingsSnapshot);
    await f.set('parent', null);
    await f.app.agentLoop.runInput(f.input('second'));
    assert.equal(f.wires[2].body.reasoning_effort, 'low');
    assert.equal((await f.frozen(result.turnId)).document.model.thinkingConfig.thinkingLevel, 'low', 'Turn identity is not rewritten');
  }, {
    async tool(f) { await f.set('parent', 'medium'); },
    async send(request, controls, f) {
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: f.requests.length === 1 ? [{ id: 'counter-1', functionCall: { name: 'counter', args: {} } }] : [{ text: 'done' }] } });
    }
  });
});

test('同一请求瞬时失败自动重试不读取保存后的思维覆盖', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    const result = await f.app.agentLoop.runInput(f.input('retry-thinking'));
    assert.equal(result.terminalStatus, 'completed');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].modelRequestId, f.requests[1].modelRequestId);
    assert.deepEqual(f.requests[0].settingsSnapshot, f.requests[1].settingsSnapshot);
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'high']);
  }, { async send(request, controls, f) {
    if (f.requests.length === 1) {
      await f.set('parent', 'medium');
      throw new kernel.ProviderTransientError('temporary_service_error', 'synthetic retry only');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
  } });
});


test('已排队输入在实际新请求冻结时采用新值，不追改在途请求', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('before-queue'));
    const admitted = await f.app.turns.admitNextQueued(f.input('queue-owner'));
    assert.ok(admitted?.turnId);
    await f.app.agentLoop.drive(admitted.turnId);
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'medium']);
  }, { async send(request, controls, f) {
    if (f.requests.length === 1) {
      const queued = await f.app.turns.input(f.input('queued-input'));
      assert.equal(queued.admitted, false);
      await f.set('parent', 'medium');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
  } });
});

test('实际 coordinator 从父工具创建/嵌套/继续子会话：最终普通 wire 不继承父覆盖', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('delegate'));


    await f.coordinator.waitForIdle();
    const childWires = f.wires.filter(w => w.conversationId !== 'parent');
    assert.ok(new Set(childWires.map(w => w.conversationId)).size >= 2, 'child and nested child ran');
    assert.ok(childWires.every(w => w.body.reasoning_effort === 'low'));
    const [child] = await f.list('ChildExecution');
    await f.set(child.child_conversation_id, 'medium');
    await f.set('parent', 'high');
    await f.app.database.conversationOwners.claim(child.child_conversation_id);
    await f.coordinator.inputFromConversation({ commandId: 'continue-child', childExecutionId: child.id, conversationId: child.child_conversation_id, content: 'continue synthetic child' });
    await f.coordinator.waitForIdle();
    assert.equal(f.wires.filter(w => w.conversationId === child.child_conversation_id).at(-1).body.reasoning_effort, 'medium');
  }, {
    async send(request, controls, f) {
      const depth = request.conversationId === 'parent' ? 0 : new Set(f.requests.filter(r => r.conversationId !== 'parent').map(r => r.conversationId)).size;
      const first = f.requests.filter(r => r.conversationId === request.conversationId).length === 1;
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: first && depth < 2 ? [{ id: `delegate-${depth}`, functionCall: { name: 'run_agent', args: { prompt: 'synthetic child', agent: { type: 'worker' } } } }] : [{ text: 'done' }] } });
    }
  });
});
