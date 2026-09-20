import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { BridgeMessageType: T } = require('../dist/extension/shared/protocol.js');

// Exercise the packaged Vue application and real browser events. The host is synthetic:
// backend persistence, CAS and wire bodies are covered by session-thinking-runtime.test.mjs.
test('built chat can read thinking, recover an expired save session, and send with inherited model', async () => {
  const root = path.resolve('dist/webview');
  const server = createServer(async (req, res) => {
    const file = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ T, state }) => {
      let host = 'host-a', seq = 0, session = 'edit-a';
      const model = { providerConfigId: 'provider', provider: 'openai-compatible', model: 'gpt-5.6-terra' };
      const provider = { id: 'provider', name: 'Test channel', provider: model.provider, model: model.model,
        baseUrl: 'https://example.invalid/v1', apiKey: '', systemPromptPrefix: '', stream: true, toolCallFormat: 'function-call',
        promptCache: { enabled: false },
        models: [{ id: model.model, name: model.model }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, createdAt: 1, updatedAt: 1 };
      let profile = { id: 'profile', name: 'thinking only', ...model, model: 'o3', inheritModel: true, thinkingOverride: { kind: 'openai-effort', value: 'low' } };
      const emit = (type, payload, correlationId) => window.postMessage({ id: crypto.randomUUID(), clientId: host, type, payload, correlationId }, '*');
      const observe = () => ({ scopeKind: 'conversation', scopeId: 'conversation', authorityId: 'root', sessionId: session,
        sequence: ++seq, revision: `r${seq}`, outcome: 'observed', effectiveModel: model, profile,
        link: { id: 'link', scopeKind: 'conversation', scopeId: 'conversation', modelProfileId: 'profile', role: 'active', createdAt: 1, updatedAt: 1 },
        profileState: profile.thinkingOverride ? 'overridden' : 'default' });
      window.requests = [];
      window.failSave = true;
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        window.requests.push(structuredClone(message));
        queueMicrotask(() => {
          const p = message.payload;
          if (message.type === T.Ready) {
            emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } });
            emit(T.ConfigurationSnapshot, { state, loadedAt: 1 });
            window.postMessage({ type: 'reliable-kernel.snapshot', sessionId: `feed-${host}`, hostBootId: host,
              messageSeq: '1', snapshotCommitSeq: '1', projections: { activeConversationWindow: { conversationId: 'conversation' },
                conversations: [{ id: 'conversation', title: 'Browser regression', status: 'active', created_at: 1, updated_at: 1 }] } }, '*');
          } else if (message.type === T.GlobalSettingsGet) {
            const settings = p.section === 'llm' ? { activeProviderConfigId: 'provider' }
              : p.section === 'llmProviderConfigs' ? { configs: [provider] }
              : p.section === 'llmCompressionConfigs' ? { configs: [] } : {};
            emit(T.GlobalSettingsSnapshot, { section: p.section, settings, revision: 'settings', loadedAt: 1 }, message.id);
          } else if (message.type === T.ModelProfileScopeRead) {
            if (p.afterRequestId) {
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'uncertain', revision: '', error: '编辑会话已失效' }, message.id);
            } else {
              if (p.renewSession) session = 'edit-renewed';
              emit(T.ModelProfileScopeSnapshot, observe(), message.id);
            }
          } else if (message.type === T.ModelProfileScopeSet) {
            if (window.failSave) {
              emit(T.Error, { requestType: message.type, message: '保存连接中断' }, message.id);
            } else {
              profile = { ...profile, ...model, thinkingOverride: p.thinkingOverride };
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'committed', operation: p.operation, expectedRevision: p.expectedRevision }, message.id);
            }
          }
        });
      } });
      window.replaceHost = () => { host = 'host-b'; session = 'edit-b'; emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } }); };
    }, { T, state: createEmptyClientState() });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const thinking = page.locator('.session-thinking-dropdown');
    await thinking.getByRole('button').filter({ hasText: '默认 · high' }).waitFor();
    await page.locator('textarea').fill('browser regression message');
    await thinking.getByRole('button').click();
    await page.getByRole('option', { name: 'medium', exact: true }).click();
    await page.getByText('保存连接中断', { exact: false }).waitFor();
    const send = page.locator('button.composer-send');
    await send.click();
    assert.equal(await page.evaluate(T => window.requests.filter(r => r.type === T.TurnStart).length, T), 0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('编辑会话已失效', { exact: false }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.payload.renewSession), T);
    await page.waitForFunction(() => !document.querySelector('.session-thinking-error'));
    await page.evaluate(() => window.replaceHost());
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.clientId === 'host-b'), T);
    await thinking.getByRole('button').filter({ hasText: '默认 · high' }).waitFor();
    await send.click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.TurnStart), T);
    const requests = await page.evaluate(() => window.requests);
    const sent = requests.find(r => r.type === T.TurnStart);
    assert.equal(sent.payload.model, undefined, 'a thinking-only profile must not pin its old model');
    assert.equal(sent.clientId, 'host-b');
    assert.equal(requests.filter(r => r.type === T.ModelProfileScopeSet).length, 1, 'recovery must not silently replay failed writes');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Browser diagnostics:', errors, await page?.locator('body').innerText(), await page?.evaluate(() => window.requests));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
