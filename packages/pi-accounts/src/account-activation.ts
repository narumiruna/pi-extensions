import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountStore, getOwnCredential, parseAccountName } from "./account-store.js";
import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./accounts.js";
import type {
  AccountActivationErrorCode,
  AccountActivationResult,
  AccountsActivationRequest,
} from "./accounts-protocol.js";
import type { AccountProviderId } from "./oauth.js";
import type { EnsureActiveProviderAuthResult } from "./runtime-auth.js";

// A replacement sync belongs to the session, not the requesting consumer. Stop waiting on
// cancellation without aborting that shared work, and release the listener on settlement.
async function waitForActivation<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function prepareAccountRequest(
  ctx: ExtensionContext,
  owner: SessionSelectionOwner,
  isOwnerCurrent: (owner: SessionSelectionOwner) => boolean,
  syncProvider: SyncProvider,
): Promise<void> {
  if (!isOwnerCurrent(owner)) return;
  const signal = ctx.signal ?? owner.signal;
  // Pi awaits turn_start before preparing a request, although ctx.isIdle() is false.
  while (isOwnerCurrent(owner) && !signal.aborted) {
    const providerId = ctx.model?.provider as AccountProviderId | undefined;
    if (!providerId || !owner.coordinators.has(providerId)) return;
    if (owner.pendingInvalidations.has(providerId)) {
      const result = await waitForActivation(syncProvider(providerId, ctx, owner, signal, ctx.model, true), signal);
      if (!result || !isOwnerCurrent(owner) || signal.aborted) return;
      if (result.status === "error") owner.abortProviders.add(providerId);
      if (ctx.model?.provider !== providerId) continue;
      if (result.status !== "error" && owner.pendingInvalidations.has(providerId)) continue;
    }
    if (owner.abortProviders.delete(providerId)) ctx.abort();
    return;
  }
}

export function createAccountActivation(
  store: AccountStore,
  adapters: ReadonlyMap<AccountProviderId, unknown>,
  getOwner: (session: object) => SessionSelectionOwner | undefined,
  isOwnerCurrent: (owner: SessionSelectionOwner) => boolean,
  persistSelection: PersistSelection,
  syncProvider: SyncProvider,
): (request: AccountsActivationRequest) => Promise<AccountActivationResult> {
  return async (request) => {
    const error = (code: AccountActivationErrorCode): AccountActivationResult => ({
      status: "error",
      providerId: request.provider,
      accountName: request.account,
      code,
    });
    const providerId = request.provider as AccountProviderId;
    if (!adapters.has(providerId)) return error("provider_unsupported");
    const owner = getOwner(request.session);
    if (!owner || !isOwnerCurrent(owner)) return error("session_unavailable");
    if (request.signal?.aborted) return error("cancelled");
    // A process override owns every managed provider; protocol selection must not bypass it.
    if (owner.environmentAccount !== undefined || owner.environmentError !== undefined)
      return error("activation_failed");
    if (request.account !== null) {
      const parsed = parseAccountName(request.account);
      if (!parsed.ok || parsed.name !== request.account) return error("account_not_found");
    }
    // Reads can wait behind refreshes; only the newest explicit request may publish its selection.
    const generation = (owner.activationRequests.get(providerId) ?? 0) + 1;
    owner.activationRequests.set(providerId, generation);
    let selectionRevision = owner.selectionRevisions.get(providerId) ?? 0;
    const isRequestCurrent = () =>
      owner.activationRequests.get(providerId) === generation &&
      (owner.selectionRevisions.get(providerId) ?? 0) === selectionRevision;
    const unavailable = (): AccountActivationResult | undefined => {
      if (!isOwnerCurrent(owner) || owner.sessionId !== owner.sessionManager.getSessionId())
        return error("session_unavailable");
      if (request.signal?.aborted) return error("cancelled");
      if (!isRequestCurrent()) return error("activation_superseded");
    };
    const activationSignal = AbortSignal.any([owner.signal, ...(request.signal ? [request.signal] : [])]);
    await waitForActivation(owner.ready, activationSignal);
    const staleAfterStartup = unavailable();
    if (staleAfterStartup) return staleAfterStartup;
    if (request.account !== null) {
      try {
        const data = await store.readAsync(
          AbortSignal.any([owner.signal, ...(request.signal ? [request.signal] : [])]),
        );
        const staleAfterRead = unavailable();
        if (staleAfterRead) return staleAfterRead;
        if (!getOwnCredential(data.providers[providerId]?.accounts ?? {}, request.account))
          return error("account_not_found");
      } catch {
        return unavailable() ?? error("store_unavailable");
      }
    }
    try {
      if (!persistSelection(owner, providerId, request.account, isRequestCurrent))
        return unavailable() ?? error("session_unavailable");
    } catch {
      return unavailable() ?? error("store_unavailable");
    }
    selectionRevision = owner.selectionRevisions.get(providerId) ?? 0;
    let task = syncProvider(providerId, owner.context, owner, request.signal);
    let result: EnsureActiveProviderAuthResult;
    try {
      // Routine model/turn syncs may replace this task without changing the selection.
      while (true) {
        const settled = await waitForActivation(task, activationSignal);
        const staleAfterSync = unavailable();
        if (staleAfterSync) return staleAfterSync;
        if (!settled) return error("activation_failed");
        result = settled;
        const latest = owner.syncTasks.get(providerId);
        if (!latest || latest === task) break;
        task = latest;
      }
    } catch {
      return unavailable() ?? error("activation_failed");
    }

    if (result.status === "error") return error(result.code ?? "activation_failed");
    if (result.status === "inactive") {
      return request.account === null
        ? { status: "inactive", providerId, accountName: null }
        : error("activation_failed");
    }
    if (result.accountName !== request.account) return error("activation_superseded");
    if (request.model && !owner.coordinators.get(providerId)?.isModelAvailable(request.model))
      return error("model_unavailable");
    return { status: "active", providerId, accountName: result.accountName };
  };
}
