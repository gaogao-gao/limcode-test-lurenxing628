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
        const wire = await dryRunLlmProvider(projected, { settings: { ...provider, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
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
      agents: { async resolve() { return { agentId: agent.id, agentType: 'worker' }; } },
      modelProfiles: { initializeConversation: ({ conversationId, model }) => configuration.mutations.initializeConversationModelProfile({ conversationId, ...model }) }
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'thinking-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'synthetic input' });
    f = { app, configuration, coordinator, provider, set, save, input, requests, wires, list, frozen };
    await run(f);
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

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
