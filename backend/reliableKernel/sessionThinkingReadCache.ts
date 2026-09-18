export interface SessionThinkingReadKey {
  providerConfigId: string;
  model: string;
  authorityId: string;
  revision: string;
}

/** Bounded immutable-revision cache. Pending work is shared; failures are never cached. */
export class SessionThinkingReadCache<T = unknown> {
  private readonly values = new Map<string, Promise<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  public constructor(private readonly limit = 128) {}

  public get(key: SessionThinkingReadKey, load: () => Promise<T>): Promise<T> {
    // Tuple encoding avoids delimiter collisions in provider/model identifiers.
    const id = JSON.stringify([key.providerConfigId, key.model, key.authorityId, key.revision]);
    const existing = this.inFlight.get(id) ?? this.values.get(id);
    if (existing) return existing;
    const pending = Promise.resolve().then(load);
    this.inFlight.set(id, pending);
    void pending.then(() => {
      // A clear/root retirement fences late completions without cancelling their callers.
      if (this.inFlight.get(id) !== pending) return;
      this.inFlight.delete(id);
      this.values.set(id, pending);
      if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
    }, () => { if (this.inFlight.get(id) === pending) this.inFlight.delete(id); });
    return pending;
  }

  public clear(): void { this.values.clear(); this.inFlight.clear(); }
}
