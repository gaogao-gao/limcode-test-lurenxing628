import type { LlmProviderKind, LlmRequestBodyRecord } from './protocol';

/** Do not silently compete with raw-body overrides. These remain editable in channel settings. */
export function hasThinkingBodyConflict(provider: LlmProviderKind, body?: LlmRequestBodyRecord): boolean {
  if (!body) return false;
  const keys = provider === 'gemini' ? ['generationConfig', 'thinkingConfig']
    : provider === 'claude' ? ['thinking', 'output_config', 'max_tokens']
    : provider === 'openai-responses' ? ['reasoning', 'max_output_tokens']
    : ['reasoning_effort', 'thinking', 'max_tokens', 'max_completion_tokens'];
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}
