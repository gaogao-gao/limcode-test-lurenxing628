/**
 * 历史视口锚定管理
 *
 * 在加载更早历史时捕获当前可见行与相对 scroller 偏移，
 * DOM 更新后基于锚点补偿 scrollTop，避免无条件 scrollTo({top: 0}) 导致视口跳转。
 * 同时通过 USER_SCROLL_INTENT_EVENT 解除父容器 sticky。
 */

import { USER_SCROLL_INTENT_EVENT, dispatchUserScrollIntent } from '@webview/composables/scrollIntent';

export interface ScrollMetricsSource {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollAnchor {
  anchorId: string | null;
  anchorIndex: number;
  metricsBeforeLoad: ScrollMetricsSource | null;
}

export function captureScrollAnchor(options: {
  scroller: HTMLElement | ScrollMetricsSource | null;
  visibleRows: readonly unknown[];
  pendingAnchorId: string | null;
}): ScrollAnchor {
  const { scroller, visibleRows, pendingAnchorId } = options;

  const metricsBeforeLoad: ScrollMetricsSource | null = scroller
    ? {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      }
    : null;

  return {
    anchorId: pendingAnchorId,
    anchorIndex: visibleRows.length > 0 ? visibleRows.length - 1 : 0,
    metricsBeforeLoad
  };
}

export function releaseStickyFromUserScroll(scroller: HTMLElement | null): void {
  if (!scroller) return;
  dispatchUserScrollIntent(scroller, { direction: 'toward-start', source: 'scrollAnchor' });
}

export function restoreScrollAfterHistoryLoad(options: {
  scroller: HTMLElement | null;
  anchor: ScrollAnchor;
  messagesLength: number;
  segmentStep: number;
}): { scrollTop: number; segmentStart: number } | null {
  const { anchor, messagesLength, segmentStep } = options;

  if (!anchor.metricsBeforeLoad || !anchor.anchorId) {
    return null;
  }

  const targetSegmentStart = Math.max(
    0,
    Math.min(messagesLength - segmentStep, Math.max(0, anchor.anchorIndex - segmentStep))
  );

  const distanceFromBottom =
    anchor.metricsBeforeLoad.scrollHeight -
    anchor.metricsBeforeLoad.scrollTop -
    anchor.metricsBeforeLoad.clientHeight;

  const targetScrollTop = Math.max(
    0,
    anchor.metricsBeforeLoad.scrollHeight - anchor.metricsBeforeLoad.clientHeight - distanceFromBottom
  );

  return {
    scrollTop: targetScrollTop,
    segmentStart: targetSegmentStart
  };
}
