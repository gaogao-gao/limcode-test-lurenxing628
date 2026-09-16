import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function withForkRuntime(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-lifecycle-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'Offline fork fixture' }),
    id: 'offline-fork-provider', model: 'offline-fork-model',
    models: [{ id: 'offline-fork-model', name: 'Offline model' }] };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [provider] }],
    ['llm', { activeProviderConfigId: provider.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  const agent = await configuration.mutations.createAgent({ name: 'Fork fixture', kind: 'custom' });
  await configuration.mutations.setModelProfile({
    scopeKind: 'conversation', scopeId: 'source', providerConfigId: provider.id,
    provider: provider.provider, model: provider.model
  });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  const environmentId = workEnvironmentIdFromUri(uri);
  await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
  await configuration.mutations.selectConversationWorkEnvironment('source', environmentId);
  const requests = [];
  let app;
  let facade;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        assert.equal(providerId, provider.id);
        return { providerId, async sendFullRequest(request, controls) {
          requests.push(request);
          await controls.onEvent({ kind: 'completed', streamSeq: '1',
            content: { role: 'model', parts: [{ text: `offline reply ${requests.length}` }] } });
        } };
      } },
      toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tools'); } }
    });
    // Exercise the production fork method without starting VS Code watchers/panels. The database,
    // ownership pins, configuration stores, context writer and agent loop remain real.
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'source', title: 'Source fixture', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'source-agent', conversation_id: 'source', agent_id: agent.id,
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const harness = {
      get app() { return app; }, get facade() { return facade; },
      get configuration() { return configuration; }, requests, environmentId,
      async reopen() { await app.close(); await open(); },
      async turn(conversationId, key) {
        // Match claim-before-open: keep the panel's reference through the whole fake-provider turn.
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
        const input = await app.turns.input({
          source: { kind: 'command', key }, conversationId, content: key,
          leaseOwnerId: 'fork-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
        });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        assert.ok(lease);
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId));
        assert.equal(result.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: input.turnId })));
        return input;
      },
      async command(conversationId, commandId, role = 'model') {
        const memberships = await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId });
        for (const member of memberships.sort((a, b) => Number(b.message_seq - a.message_seq))) {
          const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
          const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
          if (revision.role === role) return {
            sourceConversationId: conversationId, messageId: member.message_id,
            expectedRevisionId: revision.id, command: { commandId }
          };
        }
        assert.fail('fixture has no matching message');
      }
    };
    await run(harness);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const role of ['user', 'model']) {
  test(`fork at ${role} boundary continues, reopens, continues again and forks its copied history`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'source-input');
      const command = await h.command('source', `fork-${role}`, role);
      const result = await h.facade.forkConversation(command);
      const target = result.conversationId;
      assert.equal(result.deduplicated, false);
      const copiedTurns = await rows(h.app, 'Turn', { conversation_id: target });
      assert.ok(copiedTurns.length);
      assert.ok(copiedTurns.every(turn => turn.status === 'terminated'));
      assert.deepEqual(await rows(h.app, 'ExecutionLease', { conversation_id: target }), []);
      const config = await h.configuration.configurationClientState();
      assert.equal(config.conversationWorkEnvironmentLinks.find(link => link.conversationId === target)?.workEnvironmentId, h.environmentId);
      const copiedCommand = await h.command(target, `nested-${role}`, role);
      await h.turn(target, 'target-before-reopen');
      assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /source-input/);
      await h.reopen();
      await h.turn(target, 'target-after-reopen');
      assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /target-before-reopen/);
      const replay = await h.facade.forkConversation(command);
      assert.equal(replay.conversationId, target);
      assert.equal(replay.deduplicated, true);
      const nested = await h.facade.forkConversation(copiedCommand).catch(error => {
        error.message = `forking the target's copied history: ${error.message}`;
        throw error;
      });
      await h.turn(nested.conversationId, 'nested-input');
      assert.equal((await rows(h.app, 'Conversation')).length, 3);
      assert.equal((await rows(h.app, 'MessagePartOfConversation', { conversation_id: 'source' })).length, 2);
    });
  });
}

test('an early fork has no later source roots without target message provenance', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'first-source-input');
    const command = await h.command('source', 'early-fork', 'user');
    await h.turn('source', 'future-source-input');
    const sourceRoots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: 'source' });
    const fork = await h.facade.forkConversation(command);
    const targetRoots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId });
    const [head] = await rows(h.app, 'ConversationContextHeadLink', { conversation_id: fork.conversationId });
    const boundary = await h.app.context.materialize(head.root_id);
    for (const root of targetRoots) {
      const context = await h.app.context.materialize(root.id);
      assert.ok(context.segments.length <= boundary.segments.length,
        'target history must not expose source roots after its selected fork boundary');
      assert.doesNotMatch(context.segments.map(segment => segment.content).join('\n'), /future-source-input/);
      await new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore).estimateRoot(root.id);
    }
    assert.deepEqual(await rows(h.app, 'ContextSequenceRoot', { conversation_id: 'source' }), sourceRoots);
  });
});

test('configuration copy interrupted after model selection resumes the same target after reopen', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'copy-source-input');
    const command = await h.command('source', 'copy-failure');
    const store = load('backend/capabilities/vscodeStorage/recordStore.js');
    const save = store.saveRecordStore;
    let injected = false;
    store.saveRecordStore = async (root, index, records, ...rest) => {
      if (records.some(record => record.workEnvironmentId && record.conversationId !== 'source')) {
        injected = true;
        throw new Error('injected work environment copy failure');
      }
      return save(root, index, records, ...rest);
    };
    try {
      await assert.rejects(h.facade.forkConversation(command), /injected work environment copy failure/);
    } finally {
      store.saveRecordStore = save;
    }
    assert.equal(injected, true);
    const [branch] = await rows(h.app, 'ConversationBranchLink');
    const target = branch.target_conversation_id;
    let config = await h.configuration.configurationClientState();
    const modelLink = config.modelProfileScopeLinks.find(link => link.scopeId === target);
    assert.ok(modelLink, 'model copy was durable before the environment copy failed');
    assert.equal(config.conversationWorkEnvironmentLinks.some(link => link.conversationId === target), false);
    await h.reopen();
    const replay = await h.facade.forkConversation(command);
    assert.deepEqual(replay, { conversationId: target, deduplicated: true });
    config = await h.configuration.configurationClientState();
    assert.equal(config.modelProfileScopeLinks.filter(link => link.scopeId === target).length, 1);
    assert.equal(config.conversationWorkEnvironmentLinks.find(link => link.conversationId === target)?.workEnvironmentId, h.environmentId);
    await h.turn(target, 'recovered-target-input');
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
  });
});

test('lost fork result replays after a source revision change without overwriting target selections', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'revision-source-input');
    const command = await h.command('source', 'lost-result', 'user');
    const first = await h.facade.forkConversation(command);
    await h.configuration.mutations.selectConversationWorkflow({
      conversationId: first.conversationId, scopeKind: 'global'
    });
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-after-fork' }, conversationId: 'source',
      messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
      content: 'changed source after the fork committed'
    });
    await h.reopen();
    assert.deepEqual(await h.facade.forkConversation(command), { ...first, deduplicated: true });
    const config = await h.configuration.configurationClientState();
    assert.equal(config.conversationWorkflowSelections.find(item => item.conversationId === first.conversationId)?.scopeKind, 'global');
    await assert.rejects(h.facade.forkConversation({ ...command, command: { commandId: 'new-stale-fork' } }), /Revision/);
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
    await h.turn(first.conversationId, 'unchanged-fork-input');
    assert.doesNotMatch(h.requests.at(-1).context.map(item => item.content).join('\n'), /changed source after/);
  });
});

for (const fault of ['before-commit', 'revision-race']) {
  test(`fork ${fault} does not leave a partially created runtime target`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'transaction-source-input');
      const command = await h.command('source', `transaction-${fault}`, 'user');
      const database = h.app.database;
      const transaction = database.transaction.bind(database);
      let injected = false;
      database.transaction = async (steps, ...rest) => {
        if (!injected && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
          injected = true;
          if (fault === 'before-commit') throw new Error('injected fork transaction failure');
          await h.app.turns.edit({
            source: { kind: 'command', key: 'raced-source-edit' }, conversationId: 'source',
            messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
            content: 'source changed after fork read before fork commit'
          });
        }
        return transaction(steps, ...rest);
      };
      try {
        await assert.rejects(h.facade.forkConversation(command));
      } finally {
        database.transaction = transaction;
      }
      assert.equal(injected, true, 'the fault must reach the target transaction');
      assert.equal((await rows(h.app, 'Conversation')).length, 1);
      assert.deepEqual(await rows(h.app, 'ConversationBranchLink'), []);
      assert.deepEqual(await rows(h.app, 'ConversationReuseLink'), []);
      if (fault === 'before-commit') {
        const retry = await h.facade.forkConversation(command);
        assert.equal(retry.deduplicated, false);
        await h.turn(retry.conversationId, 'retry-after-transaction-failure');
      } else {
        const refreshed = await h.command('source', 'refreshed-fork', 'user');
        await h.facade.forkConversation(refreshed);
      }
      assert.equal((await rows(h.app, 'Conversation')).length, 2);
    });
  });
}

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
