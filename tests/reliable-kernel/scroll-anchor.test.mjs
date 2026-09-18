import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import path from 'node:path';

async function createWebviewTestServer() {
  return createServer({
    configFile: path.join(process.cwd(), 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
}

/**
 * 历史视口锚定行为测试。
 *
 * 断言对象是生产模块 webview/src/components/conversation/scrollAnchor.ts 的纯函数导出。
 * 该模块将在 ReliableMessageList.vue 中被调用，避免无条件 scrollTo({top: 0}) 造成的视口跳转。
 */

test('加载更早历史后恢复 segmentStart 并保留相对滚动位置', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const scrollAnchor = await server.ssrLoadModule('@webview/components/conversation/scrollAnchor');
  const { captureScrollAnchor, restoreScrollAfterHistoryLoad } = scrollAnchor;

  const anchor = captureScrollAnchor({
    scroller: null,
    visibleRows: Array.from({ length: 5 }, (_, index) => ({ id: `msg-${index}` })),
    pendingAnchorId: 'msg-2'
  });

  assert.equal(anchor.anchorId, 'msg-2');
  assert.equal(anchor.anchorIndex, 4);
  assert.equal(anchor.metricsBeforeLoad, null);
});

test('有 scroller metrics 时恢复目标 scrollTop 为相对底部偏移', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const scrollAnchor = await server.ssrLoadModule('@webview/components/conversation/scrollAnchor');
  const { captureScrollAnchor, restoreScrollAfterHistoryLoad } = scrollAnchor;

  const scrollerProxy = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 800
  };

  const anchor = captureScrollAnchor({
    scroller: scrollerProxy,
    visibleRows: Array.from({ length: 5 }, (_, index) => ({ id: `msg-${index}` })),
    pendingAnchorId: 'msg-2'
  });

  const result = restoreScrollAfterHistoryLoad({
    scroller: null,
    anchor,
    messagesLength: 60,
    segmentStep: 20
  });

  assert.ok(result !== null, '有 metrics 与 anchor 时应能恢复');
  assert.equal(result.segmentStart, 0, '锚点在 index 4 时应压缩到最前段');
  assert.equal(result.scrollTop, 0, '简化 metric 模型下顶部锚点回到顶部');
});
