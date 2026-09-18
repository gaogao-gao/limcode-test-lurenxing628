import type { LlmThinkingLevel, SessionThinkingOverride } from '../../shared/protocol';
import type { PlainJsonValue } from './plainJson';

export interface ChildThinkingInheritance {
  inheritThinking: boolean;
  thinkingOverride?: SessionThinkingOverride;
}

export function childThinkingOverrideForSpawn(input: {
  inheritThinking: boolean | undefined;
  thinkingOverride?: SessionThinkingOverride;
}): SessionThinkingOverride | undefined {
  if (input.inheritThinking !== true || !input.thinkingOverride) return undefined;
  return 'tokens' in input.thinkingOverride
    ? { kind: input.thinkingOverride.kind, tokens: input.thinkingOverride.tokens }
    : { kind: input.thinkingOverride.kind, value: input.thinkingOverride.value };
}

/** Reads only the parent conversation's explicit child-propagation facts from frozen authority. */
export function childThinkingInheritanceFromAuthority(
  document: PlainJsonValue | undefined
): ChildThinkingInheritance {
  if (!isRecord(document) || !isRecord(document.model)) return { inheritThinking: false };
  const inheritThinking = document.model.inheritThinkingToChildren === true;
  const thinkingOverride = parseThinkingOverride(document.model.thinkingOverride);
  return {
    inheritThinking,
    ...(thinkingOverride ? { thinkingOverride } : {})
  };
}

function parseThinkingOverride(value: PlainJsonValue | undefined): SessionThinkingOverride | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  if ((value.kind === 'gemini-budget' || value.kind === 'claude-budget')
    && Number.isSafeInteger(value.tokens) && (value.tokens as number) > 0) {
    return { kind: value.kind, tokens: value.tokens as number };
  }
  if ((value.kind === 'openai-effort' || value.kind === 'gemini-level'
    || value.kind === 'claude-effort' || value.kind === 'deepseek-effort')
    && isThinkingLevel(value.value)) {
    return { kind: value.kind, value: value.value };
  }
  return undefined;
}

function isThinkingLevel(value: PlainJsonValue | undefined): value is LlmThinkingLevel {
  return typeof value === 'string'
    && ['not-set', 'non-set', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

function isRecord(value: PlainJsonValue | undefined): value is { [key: string]: PlainJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
