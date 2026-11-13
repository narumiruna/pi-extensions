import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountStore, getOwnCredential } from "./account-store.js";
import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./accounts.js";
import { type FailoverSettings, readFailoverSettings } from "./failover-settings.js";
import { evaluateUsageAllowance, type QuotaDecision, readUsageAllowance } from "./failover-usage.js";
import type { AccountProviderId } from "./oauth.js";

const CHECK_INTERVAL_MS = 5 * 60_000;
const ATTEMPT_MS = 45_000;
const RECOVERY_MS = 14_000;
const BLOCK_MS = 1_000;

type Recovery = { account: string | null; revision: number };
type Policy = { settings: FailoverSettings; error?: string };
type Attempt = { controller: AbortController; task: Promise<void> };

// Bound even provider operations that cannot interrupt their underlying transport. The
// coordinator's operation ownership prevents their late result from replacing recovery.
async function wait<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => undefined);
    signal.throwIfAborted();
  }
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new DOMException("Account failover cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Session-owned policy. All activation happens inside the awaited account request gate. */
export class AccountFailover {
  private policies = new Map<AccountProviderId, Policy>();
  private generation = 0;
  private active?: Attempt;
  private readonly recovery = new Map<AccountProviderId, Recovery>();
  private readonly checks = new Map<AccountProviderId, { identity: string; at: number }>();
  private readonly excluded = new Map<string, number | undefined>();
  private readonly messages = new Map<AccountProviderId, string>();
  private readonly notices = new Set<string>();

  constructor(
    private readonly pi: Pick<ExtensionAPI, "events">,
    private readonly store: AccountStore,
    private readonly owner: SessionSelectionOwner,
    private readonly isOwnerCurrent: (owner: SessionSelectionOwner) => boolean,
    private readonly persist: PersistSelection,
    private readonly sync: SyncProvider,
  ) {}

  async reload(): Promise<void> {
    const generation = ++this.generation;
    // No automatic decision may use cached settings while a reload is pending or failed.
    this.policies.clear();
    this.active?.controller.abort();
    const data = await this.store.readAsync(this.owner.signal);
    if (!this.current() || generation !== this.generation) return;
    const policies = new Map<AccountProviderId, Policy>();
    for (const provider of this.owner.coordinators.keys()) {
      const state = data.providers[provider];
      if (state) policies.set(provider, readFailoverSettings(state));
    }
    this.policies = policies;
    this.checks.clear();
    this.excluded.clear();
    for (const [provider, policy] of policies) {
      if (policy.error) this.note(this.owner.context, provider, policy.error);
    }
  }

  status(provider: string): string {
    const id = provider as AccountProviderId;
    if (this.owner.environmentAccount !== undefined || this.owner.environmentError !== undefined)
      return "Failover unavailable: PI_ACCOUNT owns the selection.";
    const policy = this.policies.get(id);
    if (policy?.error) return `Failover unavailable: ${policy.error}`;
    if (!policy?.settings.enabled) return "Failover off.";
    const { accounts, minRemainingPercent } = policy.settings;
    return `Backups: ${accounts.join(", ")}. Remaining allowance threshold: ${minRemainingPercent}%. ${this.messages.get(id) ?? "Usage will be checked before a model request."}`;
  }

  explicitSelection(provider: AccountProviderId): void {
    this.active?.controller.abort();
    this.recovery.delete(provider);
    this.checks.delete(provider);
    for (const key of this.excluded.keys()) if (key.startsWith(`${provider}\0`)) this.excluded.delete(key);
  }

  cancelTrial(provider: AccountProviderId): void {
    if (this.owner.trialSelections.has(provider)) this.active?.controller.abort();
  }

  dispose(): void {
    ++this.generation;
    this.active?.controller.abort();
    this.owner.trialSelections.clear();
    this.recovery.clear();
    this.checks.clear();
    this.excluded.clear();
    this.messages.clear();
    this.notices.clear();
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    if (!this.current() || !ctx.isIdle()) return;
    for (const [provider, recovery] of this.recovery) {
      if (!this.current() || !ctx.isIdle()) return;
      await this.restore(ctx, provider, recovery);
    }
  }

  async prepare(ctx: ExtensionContext): Promise<void> {
    if (!this.current()) return;
    if (this.active) {
      await this.active.task;
      return;
    }
    const provider = ctx.model?.provider as AccountProviderId | undefined;
    if (!provider || !this.owner.coordinators.has(provider)) return;
    const recovery = this.recovery.get(provider);
    if (recovery && !(await this.restore(ctx, provider, recovery))) return;
    const policy = this.policies.get(provider);
    if (
      !this.current() ||
      !ctx.model ||
      ctx.signal?.aborted ||
      this.owner.error ||
      this.owner.environmentAccount !== undefined ||
      this.owner.environmentError !== undefined ||
      policy?.error ||
      !policy?.settings.enabled ||
      policy.settings.accounts.length === 0 ||
      this.owner.results.get(provider)?.status === "error"
    )
      return;
    const identity = this.identity(ctx, provider);
    const check = this.checks.get(provider);
    if (check?.identity === identity && Date.now() - check.at < CHECK_INTERVAL_MS) return;
    this.checks.set(provider, { identity, at: Date.now() });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.owner.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const timer = setTimeout(() => controller.abort(), ATTEMPT_MS);
    const task = this.run(ctx, provider, policy.settings, signal).finally(() => {
      clearTimeout(timer);
      if (this.active?.controller === controller) this.active = undefined;
    });
    this.active = { controller, task };
    await task;
  }

  private current(): boolean {
    return this.isOwnerCurrent(this.owner) && this.owner.sessionManager.getSessionId() === this.owner.sessionId;
  }

  private identity(ctx: ExtensionContext, provider: AccountProviderId): string {
    // Authentication identities remain private in memory and are never displayed or persisted.
    return JSON.stringify([
      ctx.model,
      this.owner.selectionRevisions.get(provider),
      this.owner.appliedIdentities.get(provider),
      this.generation,
    ]);
  }

  private excludedAccount(provider: AccountProviderId, account: string | null): boolean {
    const key = `${provider}\0${account ?? "default"}`;
    if (!this.excluded.has(key)) return false;
    const until = this.excluded.get(key);
    if (until !== undefined && Date.now() >= until) {
      this.excluded.delete(key);
      return false;
    }
    return true;
  }

  private exclude(provider: AccountProviderId, account: string | null, decision: QuotaDecision): void {
    this.excluded.set(`${provider}\0${account ?? "default"}`, decision.resetsAt);
  }

  private stage(provider: AccountProviderId, account: string | null, isCurrent: () => boolean): boolean {
    if (!this.current() || !isCurrent()) return false;
    // Only accepted choices belong in owner.selections and persisted snapshots.
    if (account === null || account === this.owner.selections[provider]) this.owner.trialSelections.delete(provider);
    else this.owner.trialSelections.set(provider, account);
    this.owner.selectionRevisions.set(provider, (this.owner.selectionRevisions.get(provider) ?? 0) + 1);
    return true;
  }

  private async run(
    ctx: ExtensionContext,
    provider: AccountProviderId,
    settings: FailoverSettings,
    signal: AbortSignal,
  ): Promise<void> {
    const original = this.owner.selections[provider] ?? null;
    if (this.excludedAccount(provider, original)) return;
    const generation = this.generation;
    const model = JSON.stringify(ctx.model);
    const modelId = ctx.model?.id;
    let revision = this.owner.selectionRevisions.get(provider) ?? 0;
    const activation = this.owner.activationRequests.get(provider) ?? 0;
    let identity = this.owner.appliedIdentities.get(provider);
    const owned = () =>
      this.current() &&
      (this.owner.selectionRevisions.get(provider) ?? 0) === revision &&
      (this.owner.activationRequests.get(provider) ?? 0) === activation;
    const valid = () =>
      owned() &&
      !signal.aborted &&
      generation === this.generation &&
      model === JSON.stringify(ctx.model) &&
      identity === this.owner.appliedIdentities.get(provider);
    const quota = async () => {
      const startedAt = Date.now();
      const value = await readUsageAllowance(this.pi, ctx, signal);
      if (!valid() || !modelId) return { kind: "unknown" } as const;
      // These are the client's detached local outcomes, never provider error text.
      if (
        value &&
        typeof value === "object" &&
        Object.getOwnPropertyDescriptor(value, "status")?.value === "unavailable" &&
        Object.getOwnPropertyDescriptor(value, "reason")?.value === "no-service"
      )
        return { kind: "unknown", reason: "no-service" } as const;
      return evaluateUsageAllowance(value, provider, modelId, settings.minRemainingPercent, startedAt);
    };
    let recovery: Recovery | undefined;
    try {
      const data = await this.store.readAsync(signal);
      if (!valid()) return;
      const decision = await quota();
      if (!valid()) return;
      if (decision.kind !== "low") {
        this.note(
          ctx,
          provider,
          decision.kind === "adequate"
            ? "Current allowance is above the threshold."
            : decision.reason === "no-service"
              ? "No compatible usage service; automatic failover unavailable."
              : "No verified applicable usage report for this model and authentication; account unchanged.",
          false,
        );
        return;
      }
      this.exclude(provider, original, decision);
      const candidates = settings.accounts.filter(
        (account) =>
          account !== original &&
          !this.excludedAccount(provider, account) &&
          getOwnCredential(data.providers[provider]?.accounts ?? {}, account),
      );
      for (const candidate of candidates) {
        if (!valid()) break;
        recovery ??= { account: original, revision };
        this.recovery.set(provider, recovery);
        if (!this.stage(provider, candidate, valid)) break;
        revision = this.owner.selectionRevisions.get(provider) ?? 0;
        recovery.revision = revision;
        const result = await wait(this.sync(provider, ctx, this.owner, signal, ctx.model, true), signal);
        if (!owned()) break;
        identity = this.owner.appliedIdentities.get(provider);
        if (
          !valid() ||
          result.status !== "active" ||
          result.accountName !== candidate ||
          !this.owner.coordinators.get(provider)?.isModelAvailable(modelId ?? "")
        )
          break;
        const candidateQuota = await quota();
        if (!valid()) break;
        if (candidateQuota.kind === "adequate") {
          if (!this.persist(this.owner, provider, candidate, valid, true)) break;
          revision = this.owner.selectionRevisions.get(provider) ?? 0;
          recovery.revision = revision;
          this.recovery.delete(provider);
          recovery = undefined;
          this.checks.set(provider, { identity: this.identity(ctx, provider), at: Date.now() });
          this.note(
            ctx,
            provider,
            `Switched from ${original ?? "Pi built-in login"} to ${candidate}: remaining allowance was at or below ${settings.minRemainingPercent}%.`,
          );
          return;
        }
        if (candidateQuota.kind !== "low") break;
        this.exclude(provider, candidate, candidateQuota);
      }
      if (owned()) this.note(ctx, provider, "No verified adequate backup; restoring the original account.");
    } catch {
      // Failure is not permission to try another account. Restore only our own selection.
      if (owned())
        this.note(ctx, provider, "Failover check did not complete; account recovery is required if selection changed.");
    } finally {
      if (recovery && this.current()) await this.restore(ctx, provider, recovery);
    }
  }

  private async restore(ctx: ExtensionContext, provider: AccountProviderId, recovery: Recovery): Promise<boolean> {
    let syncTask: ReturnType<SyncProvider> | undefined;
    const owned = () =>
      this.current() &&
      this.recovery.get(provider) === recovery &&
      (this.owner.selectionRevisions.get(provider) ?? 0) === recovery.revision &&
      (!syncTask || this.owner.syncTasks.get(provider) === syncTask);
    if (!owned()) {
      if (this.recovery.get(provider) === recovery) this.recovery.delete(provider);
      return false;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.owner.signal]);
    const timer = setTimeout(() => controller.abort(), RECOVERY_MS);
    try {
      // A pending explicit request is not a committed selection. Give it priority,
      // but recover if lookup/auth is cancelled before it changes the selection.
      while (owned()) {
        const pending = this.owner.activationTasks?.get(provider);
        if (!pending) break;
        await wait(pending, signal);
      }
      if (!owned()) {
        if (this.recovery.get(provider) === recovery) this.recovery.delete(provider);
        return false;
      }
      if (this.owner.trialSelections.has(provider)) {
        if (!this.stage(provider, recovery.account, owned)) return false;
        recovery.revision = this.owner.selectionRevisions.get(provider) ?? 0;
      }
      syncTask = this.sync(provider, ctx, this.owner, signal, ctx.model, true);
      const result = await wait(syncTask, signal);
      if (!owned()) return false;
      if (
        result.status === "error" ||
        signal.aborted ||
        (ctx.model?.provider === provider && this.owner.pendingInvalidations.has(provider))
      )
        throw new Error("Recovery could not verify authentication.");
      this.recovery.delete(provider);
      this.checks.set(provider, { identity: this.identity(ctx, provider), at: Date.now() });
      return true;
    } catch {
      if (owned()) {
        const coordinator = this.owner.coordinators.get(provider);
        coordinator?.invalidate(ctx);
        this.owner.abortProviders.add(provider);
        this.owner.pendingInvalidations.add(provider);
        this.note(ctx, provider, "Account recovery failed; requests remain blocked. Select an account from /accounts.");
        if (ctx.model?.provider === provider) ctx.abort();
        if (coordinator) {
          const block = new AbortController();
          const deadline = setTimeout(() => block.abort(), BLOCK_MS);
          try {
            const result = await wait(
              coordinator.forceFailClosed(
                ctx,
                recovery.account ?? "default",
                new Error("Account failover recovery could not verify authentication."),
              ),
              AbortSignal.any([block.signal, this.owner.signal]),
            );
            if (owned()) this.owner.results.set(provider, result);
          } catch {
            /* The request gate remains blocked even if runtime publication is delayed. */
          } finally {
            clearTimeout(deadline);
          }
        }
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private note(ctx: ExtensionContext, provider: AccountProviderId, message: string, notify = true): void {
    if (!this.current()) return;
    this.messages.set(provider, message);
    const key = `${provider}:${message}`;
    if (!notify || this.notices.has(key) || !ctx.hasUI) return;
    this.notices.add(key);
    try {
      ctx.ui.notify(message, "info");
    } catch {
      /* Session replacement owns UI cleanup. */
    }
  }
}
