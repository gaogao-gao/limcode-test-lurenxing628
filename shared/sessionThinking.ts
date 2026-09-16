import type { LlmGenerationConfigRecord, LlmProviderKind, LlmThinkingConfigRecord, LlmThinkingLevel, SessionThinkingOverride } from './protocol';
import { isAstraModel } from './openAIResponsesCapabilities';
import { geminiThinkingCapabilityForModel } from './geminiThinking';

export type SessionThinkingCapability =
  | { kind: 'gemini-budget' | 'claude-budget'; min: number; max: number; automatic?: number; allowZero?: boolean }
  | { kind: 'openai-effort' | 'gemini-level' | 'claude-effort' | 'deepseek-effort'; values: readonly LlmThinkingLevel[] };

/** Conservative allowlist: unknown relay aliases retain their existing settings, but get no shortcut. */
export function sessionThinkingCapability(provider: LlmProviderKind, modelId: string, maxOutputTokens?: number): SessionThinkingCapability | undefined {
  const model = modelId.toLowerCase().replace(/^models\//, '');
  if (provider === 'gemini') {
    const capability = geminiThinkingCapabilityForModel(model);
    if (capability.kind === 'thinkingLevel') return { kind: 'gemini-level', values: capability.levels };
    if (capability.kind === 'thinkingBudget' && !/image|audio|tts|live/.test(model)) {
      if (model.includes('pro')) return { kind: 'gemini-budget', min: 128, max: 32768, automatic: -1 };
      if (model.includes('flash')) return { kind: 'gemini-budget', min: model.includes('lite') ? 512 : 1, max: 24576, automatic: -1, allowZero: true };
    }
    return undefined;
  }
  if (provider === 'claude') {
    if (/^claude-(opus|sonnet)-4[.-][6-9](?:-|$)/.test(model)) {
      return { kind: 'claude-effort', values: model.includes('opus') ? ['none', 'low', 'medium', 'high', 'max'] : ['none', 'low', 'medium', 'high'] };
    }
    if (/^claude-(?:3[.-]7-sonnet|(?:sonnet|opus)-4(?:[.-][015])?)(?:-|$)/.test(model) && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens! > 1024) {
      return { kind: 'claude-budget', min: 1024, max: maxOutputTokens! - 1 };
    }
    return undefined;
  }
  if (provider === 'openai-compatible' || provider === 'openai-responses') {
    if (/^o[134](?:-|$)/.test(model) && !/^o1-(?:mini|preview)/.test(model)) return { kind: 'openai-effort', values: ['low', 'medium', 'high'] };
    if (/^gpt-5(?:[.-]|$)/.test(model) && !/chat|pro/.test(model)) {
      return { kind: 'openai-effort', values: /^gpt-5(?:-|$)/.test(model) ? ['minimal', 'low', 'medium', 'high'] : ['none', 'low', 'medium', 'high', 'xhigh'] };
    }
    if (isAstraModel(model) && provider === 'openai-responses') return { kind: 'openai-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] };
  }
  if (provider === 'deepseek' && /^deepseek-(?:reasoner|v4)(?:-|$)/.test(model)) return { kind: 'deepseek-effort', values: ['none', 'high', 'max'] };
  return undefined;
}

export function validateSessionThinkingOverride(value: SessionThinkingOverride, provider: LlmProviderKind, model: string, generation?: LlmGenerationConfigRecord): SessionThinkingOverride {
  const capability = sessionThinkingCapability(provider, model, generation?.maxOutputTokens);
  if (!value || !capability || value.kind !== capability.kind) throw new Error('当前模型不支持此思维参数，请恢复默认或重新选择。');
  if ('tokens' in value && 'min' in capability) {
    if (!Number.isSafeInteger(value.tokens) || !(value.tokens === capability.automatic || (capability.allowZero && value.tokens === 0) || (value.tokens >= capability.min && value.tokens <= capability.max))) throw new Error('思维预算超出当前模型合法范围。');
    if (value.tokens > 0 && generation?.maxOutputTokens !== undefined && value.tokens >= generation.maxOutputTokens) throw new Error('思维预算必须小于最大输出 Token。');
    return { kind: value.kind, tokens: value.tokens };
  }
  if ('value' in value && 'values' in capability && capability.values.includes(value.value)) return { kind: value.kind, value: value.value };
  throw new Error('当前模型不支持此思维等级。');
}

export function applySessionThinkingOverride(generation: LlmGenerationConfigRecord | undefined, override: SessionThinkingOverride | undefined): LlmGenerationConfigRecord {
  const result = { ...generation, ...(generation?.thinkingConfig ? { thinkingConfig: { ...generation.thinkingConfig } } : {}) };
  if (!override) return result;
  const thinkingConfig = { ...result.thinkingConfig };
  delete thinkingConfig.thinkingBudget;
  delete thinkingConfig.thinkingLevel;
  if ('tokens' in override) thinkingConfig.thinkingBudget = override.tokens;
  else thinkingConfig.thinkingLevel = override.value;
  return { ...result, thinkingConfig };
}

export function thinkingValueLabel(thinking?: LlmThinkingConfigRecord): string {
  if (thinking?.thinkingLevel && !['not-set', 'non-set'].includes(thinking.thinkingLevel)) return thinking.thinkingLevel;
  if (thinking?.thinkingBudget !== undefined) return thinking.thinkingBudget === -1 ? '自动（-1）' : `${thinking.thinkingBudget} tokens`;
  return '服务默认';
}
