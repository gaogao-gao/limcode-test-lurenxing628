import { defineStore } from 'pinia';
import { type ConfigScopeKind, type LlmProviderKind, type ModelProfileRecord, type ModelProfileScopeLinkRecord, type SessionThinkingOverride } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

interface PendingModelProfileSelection {
  requestId: string;
  profile: ModelProfileRecord;
  link: ModelProfileScopeLinkRecord;
  error?: string;
}
interface SelectionInput { name?: string; providerConfigId?: string; provider?: LlmProviderKind; model: string; thinkingOverride?: SessionThinkingOverride | null }
const waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
function settle(id: string, error?: string): void {
  for (const waiter of waiters.get(id) ?? []) error ? waiter.reject(new Error(error)) : waiter.resolve();
  waiters.delete(id);
}
function plainThinking(value: SessionThinkingOverride): SessionThinkingOverride {
  return 'tokens' in value ? { kind: value.kind, tokens: value.tokens } : { kind: value.kind, value: value.value };
}
function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: ModelProfileScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }

export const useModelProfileStore = defineStore('modelProfile', {
  state: () => ({ status: '', pendingSelections: {} as Record<string, PendingModelProfileSelection> }),
  actions: {
    localProfileFor(scopeKind: ConfigScopeKind, scopeId?: string): { profile?: ModelProfileRecord; link?: ModelProfileScopeLinkRecord } {
      const pending = this.pendingSelections[pendingKey(scopeKind, scopeId)];
      if (pending) return { profile: pending.profile, link: pending.link };
      const clientState = useClientStateStore();
      const link = latest(clientState.modelProfileScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const profile = clientState.modelProfiles.find((item) => item.id === link?.modelProfileId);
      return { ...(profile ? { profile } : {}), ...(link ? { link } : {}) };
    },
    pendingFor(scopeKind: ConfigScopeKind, scopeId?: string): PendingModelProfileSelection | undefined {
      return this.pendingSelections[pendingKey(scopeKind, scopeId)];
    },
    setProfileForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, input: SelectionInput): void {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const key = pendingKey(scopeKind, scopeId);
      const prior = this.pendingSelections[key];
      if (prior) settle(prior.requestId, '选择已更新，请再次发送。');
      const thinkingOverride = input.thinkingOverride ? plainThinking(input.thinkingOverride) : null;
      const requestId = bridge.request(BridgeMessageType.ModelProfileScopeSet, {
        scopeKind, ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
        ...(input.provider ? { provider: input.provider } : {}), model: input.model,
        ...(scopeKind === 'conversation' ? { thinkingOverride } : {})
      });
      const now = Date.now();
      const scopeSuffix = `${scopeKind}:${normalizedScopeId ?? 'global'}`;
      const profile: ModelProfileRecord = {
        id: `model-profile:${scopeSuffix}`, name: input.name?.trim() || 'LLM 配置',
        ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
        ...(input.provider ? { provider: input.provider } : {}), model: input.model.trim(),
        ...(thinkingOverride ? { thinkingOverride } : {})
      };
      this.pendingSelections[key] = {
        requestId, profile,
        link: { id: `model-profile-scope:${scopeSuffix}`, scopeKind,
          ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}), modelProfileId: profile.id,
          role: 'active', createdAt: now, updatedAt: now }
      };
      this.status = '正在保存 LLM 配置…';
      setTimeout(() => {
        if (this.pendingSelections[key]?.requestId === requestId) this.rejectPending(requestId, '未确认保存成功；选择已保留，请重试或撤销。');
      }, 10000);
    },
    async awaitSavedForScope(scopeKind: ConfigScopeKind, scopeId?: string): Promise<void> {
      const pending = this.pendingFor(scopeKind, scopeId);
      if (!pending) return;
      if (pending.error) throw new Error(pending.error);
      await new Promise<void>((resolve, reject) => {
        const list = waiters.get(pending.requestId) ?? [];
        list.push({ resolve, reject });
        waiters.set(pending.requestId, list);
      });
    },
    reconcileSnapshot(correlationId?: string): void {
      if (!correlationId) return;
      for (const [key, pending] of Object.entries(this.pendingSelections)) {
        if (pending.requestId !== correlationId) continue;
        delete this.pendingSelections[key];
        settle(correlationId);
        this.status = 'LLM 配置已同步';
      }
    },
    rejectPending(correlationId: string | undefined, message: string): void {
      if (!correlationId) return;
      for (const pending of Object.values(this.pendingSelections)) {
        if (pending.requestId !== correlationId) continue;
        pending.error = message;
        settle(correlationId, message);
        this.status = message;
      }
    },
    discardPending(scopeKind: ConfigScopeKind, scopeId?: string): void {
      const key = pendingKey(scopeKind, scopeId);
      const pending = this.pendingSelections[key];
      if (!pending?.error) return;
      // Write the confirmed selection back; a late original save must not win over undo.
      const client = useClientStateStore();
      const link = latest(client.modelProfileScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const profile = client.modelProfiles.find((item) => item.id === link?.modelProfileId);
      if (profile) this.setProfileForScope(scopeKind, scopeId, { ...profile, thinkingOverride: profile.thinkingOverride ?? null });
      else this.setProfileForScope(scopeKind, scopeId, { ...pending.profile, thinkingOverride: null });
    },
    clearProfileScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.modelProfileScopeLinks = clientState.modelProfileScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ModelProfileScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    }
  }
});
function pendingKey(scopeKind: ConfigScopeKind, scopeId?: string): string { return `${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`; }
