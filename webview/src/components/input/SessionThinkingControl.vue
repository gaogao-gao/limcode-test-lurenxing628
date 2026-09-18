<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LlmProviderConfigRecord, SessionThinkingOverride } from '@shared/protocol';
import { applySessionThinkingOverride, sessionThinkingCapability, sessionThinkingDisplayLabel, validateSessionThinkingOverride } from '@shared/sessionThinking';
import { hasThinkingBodyConflict } from '@shared/sessionThinkingBody';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import SettingsDropdown from '@webview/components/settings/global/SettingsDropdown.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';

const props = defineProps<{ conversationId: string; config: LlmProviderConfigRecord; model: string; recent: string }>();
const store = useModelProfileStore();
const input = ref('');
const error = ref('');
const modelConfig = computed(() => props.config.modelConfigs.find((item) => item.modelId === props.model));
const generation = computed(() => modelConfig.value ? modelConfig.value.generationConfig : props.config.generationConfig);
const requestBody = computed(() => modelConfig.value ? modelConfig.value.requestBody : props.config.requestBody);
const conflict = computed(() => hasThinkingBodyConflict(props.config.provider, requestBody.value));
const capability = computed(() => sessionThinkingCapability(props.config.provider, props.model, generation.value?.maxOutputTokens));
const override = computed(() => {
  const profile = store.localProfileFor('conversation', props.conversationId).profile;
  return profile?.providerConfigId === props.config.id && profile.model === props.model ? profile.thinkingOverride : undefined;
});
const defaultLabel = computed(() => sessionThinkingDisplayLabel(props.config.provider, props.model, generation.value?.thinkingConfig));
const selected = computed(() => override.value ? 'tokens' in override.value ? String(override.value.tokens) : override.value.value : 'default');
const options = computed(() => {
  const result = [{ value: 'default', label: `默认：${defaultLabel.value}` }];
  const cap = capability.value;
  if (cap && 'values' in cap) return [...result, ...cap.values.map((value) => ({ value, label: value }))];
  if (cap && 'min' in cap) {
    const tokens = [...new Set([...(cap.automatic === undefined ? [] : [cap.automatic]), ...(cap.allowZero ? [0] : []), cap.min, 4096, 8192, 16384, ...((override.value && 'tokens' in override.value) ? [override.value.tokens] : [])])];
    return [...result, ...tokens.filter((value) => {
      try { validateSessionThinkingOverride({ kind: cap.kind, tokens: value }, props.config.provider, props.model, generation.value, requestBody.value); return true; } catch { return false; }
    }).map((value) => ({ value: String(value), label: value === -1 ? '自动（-1）' : `${value} tokens` }))];
  }
  return result;
});
const summary = computed(() => conflict.value ? '由自定义请求体控制' : sessionThinkingDisplayLabel(props.config.provider, props.model, applySessionThinkingOverride(generation.value, override.value).thinkingConfig));
function save(value: string): void {
  error.value = '';
  const cap = capability.value;
  if (!cap && value !== 'default') return;
  let thinkingOverride: SessionThinkingOverride | null = null;
  try {
    if (value !== 'default' && cap) thinkingOverride = validateSessionThinkingOverride('min' in cap ? { kind: cap.kind, tokens: Number(value) } : { kind: cap.kind, value: value as never }, props.config.provider, props.model, generation.value, requestBody.value);
    store.setThinkingForScope(props.conversationId, { providerConfigId: props.config.id, provider: props.config.provider, model: props.model }, thinkingOverride);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
}
watch(() => [props.conversationId, props.config.id, props.model], () => { input.value = ''; error.value = ''; });
</script>

<template>
  <div v-if="capability || override || generation?.thinkingConfig" class="session-thinking">
    <SettingsDropdown :model-value="selected" :options="options" :disabled="conflict || !capability" placement="top" :max-height="220" @update:model-value="save" />
    <HoverTooltipPanel panel-title="会话思维参数" :rows="[
      { label: '当前选择', value: summary }, { label: '最近请求（冻结值）', value: recent },
      { label: '能力判断', value: capability ? '按模型标识和本地适配器；第三方服务未验证' : '未知能力，保留渠道默认，不发送新增参数' },
      { label: '生效时机', value: '仅本对话，保存后下一新请求；在途与重试不变' },
      ...(conflict ? [{ label: '自定义请求体', value: '请在渠道设置修改，此入口不覆盖原始请求体' }] : [])
    ]">
      <span tabindex="0" class="thinking-info">思维</span>
    </HoverTooltipPanel>
    <template v-if="capability && 'min' in capability && !conflict">
      <input v-model="input" type="number" aria-label="自定义思维 Token 预算" placeholder="预算" @keydown.enter.stop.prevent="input.trim() && save(input)">
      <button type="button" :disabled="!input.trim()" @click="save(input)">应用</button>
    </template>
    <button v-if="override && (conflict || !capability)" type="button" @click="save('default')">恢复默认</button>
    <span v-if="!capability">未知能力</span>
    <span v-if="error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.session-thinking { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }
.session-thinking input { width: 70px; background: transparent; color: inherit; border: 1px solid var(--vscode-panel-border); }
.session-thinking button { background: transparent; color: inherit; border: 1px solid var(--vscode-panel-border); cursor: pointer; }
.thinking-info { opacity: .7; cursor: help; }
[role=alert] { color: var(--vscode-errorForeground); max-width: 240px; }
</style>
