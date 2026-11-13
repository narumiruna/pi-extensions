import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAccountCommand, hasEnvironmentSelection, isDefaultPiLoginArg } from "./account-command.js";

export { DEFAULT_PI_LOGIN_LABEL } from "./account-command.js";

import { createAccountActivation, prepareAccountRequest } from "./account-activation.js";
import { AccountFailover } from "./account-failover.js";
import {
  AccountStore,
  consumeMigrationNotice,
  getOwnCredential,
  parseAccountName,
  type StoredCredential,
} from "./account-store.js";
import { ACCOUNTS_SELECTION_COMMITTED_CHANNEL, registerAccountsProtocol } from "./accounts-protocol.js";
import {
  type AccountProviderAdapter,
  type AccountProviderId,
  createBuiltinProviderAdapters,
  SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import {
  parseCredentialReadinessRequest,
  parseCredentialRequest,
  registerOAuthCredentialReadiness,
  registerOAuthCredentialSource,
} from "./oauth-credential-source.js";
import {
  type EnsureActiveProviderAuthResult,
  RUNTIME_FAIL_CLOSED_API_KEY,
  RuntimeAuthCoordinator,
  redactTokenText,
} from "./runtime-auth.js";
import {
  ACCOUNT_SELECTION_ENTRY_TYPE,
  cloneAccountSelections,
  createAccountSelectionEntryData,
  type ProviderAccountSelections,
  restoreAccountSelections,
  setAccountSelection,
} from "./session-selection.js";

export {
  ACCOUNTS_FILE,
  AccountStore,
  type AccountsData,
  InMemoryAccountStorageBackend,
  LEGACY_CODEX_ACCOUNTS_FILE,
  migrateLegacyCodexAccountsFile,
  type ProviderAccountsData,
  parseAccountName,
  parseAccountsData,
  type StoredApiKeyCredential,
  type StoredCredential,
  type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;

export type AccountsDependencies = {
  store?: AccountStore;
  providers?: readonly AccountProviderAdapter[];
  closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
};

type SessionEntryWriter = {
  appendCustomEntry(customType: string, data?: unknown): string;
};

export type SessionSelectionOwner = {
  context: ExtensionContext;
  sessionManager: ExtensionContext["sessionManager"] & SessionEntryWriter;
  sessionId: string;
  selections: ProviderAccountSelections;
  trialSelections: Map<AccountProviderId, string>;
  selectionRevisions: Map<AccountProviderId, number>;
  activationRequests: Map<AccountProviderId, number>;
  activationTasks?: Map<AccountProviderId, Promise<void>>;
  error?: string;
  environmentAccount?: string;
  environmentError?: string;
  controller: AbortController;
  signal: AbortSignal;
  ready: Promise<void>;
  coordinators: Map<AccountProviderId, RuntimeAuthCoordinator>;
  results: Map<AccountProviderId, EnsureActiveProviderAuthResult>;
  appliedIdentities: Map<AccountProviderId, string>;
  pendingInvalidations: Set<AccountProviderId>;
  preparingRun: boolean;
  abortProviders: Set<AccountProviderId>;
  syncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  pendingSyncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  startupTask: Promise<void>;
  startupTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
  startupCompletedProviders: Set<AccountProviderId>;
  failover?: AccountFailover;
};

export type SyncProvider = (
  providerId: AccountProviderId,
  ctx: ExtensionContext,
  owner: SessionSelectionOwner,
  ownerSignal?: AbortSignal,
  model?: ExtensionContext["model"],
  beforeRequest?: boolean,
) => Promise<EnsureActiveProviderAuthResult>;

export type PersistSelection = (
  owner: SessionSelectionOwner,
  providerId: AccountProviderId,
  accountName: string | null,
  isCurrent: () => boolean,
  automatic?: boolean,
) => boolean;

export default function accountsExtension(pi: ExtensionAPI, dependencies: AccountsDependencies = {}): void {
  const store = dependencies.store ?? new AccountStore();
  let migrationNotice = dependencies.store ? undefined : consumeMigrationNotice();
  const providers = [
    ...(dependencies.providers ??
      createBuiltinProviderAdapters({ closeCodexWebSockets: dependencies.closeCodexWebSockets })),
  ];
  validateProviderSet(providers, dependencies.providers === undefined);
  const adapters = new Map(providers.map((provider) => [provider.id, provider]));
  const sessionOwners = new WeakMap<ExtensionContext["sessionManager"], SessionSelectionOwner>();
  registerOAuthCredentialSource(pi, [
    {
      offerCredential(data) {
        const request = parseCredentialRequest(data);
        if (!request) return;
        const owner = sessionOwners.get(request.session as ExtensionContext["sessionManager"]);
        const providerId = toProviderId(request.provider);
        if (!owner || !providerId) return;
        owner.coordinators.get(providerId)?.offerCredential(data);
      },
    },
  ]);

  const isOwnerCurrent = (owner: SessionSelectionOwner): boolean =>
    sessionOwners.get(owner.sessionManager) === owner && !owner.signal.aborted;

  const initializeOwner = async (owner: SessionSelectionOwner, ctx: ExtensionContext): Promise<void> => {
    const restored = restoreAccountSelections(ctx.sessionManager.getEntries(), owner.sessionId);
    if (restored.status === "invalid") {
      owner.error = restored.message;
      ctx.ui.notify(
        owner.environmentAccount === undefined
          ? restored.message
          : "The saved session selection is invalid, but PI_ACCOUNT remains active. Unset it and restart Pi to recover via /accounts.",
        owner.environmentAccount === undefined ? "error" : "warning",
      );
      return;
    }
    let selections =
      restored.status === "loaded"
        ? restored.selections
        : cloneAccountSelections(Object.create(null) as ProviderAccountSelections);
    const missingProviders = providers.filter((provider) => !Object.hasOwn(selections, provider.id));
    if (restored.status === "loaded" && missingProviders.length === 0) {
      owner.selections = selections;
      return;
    }
    try {
      const data = await store.readAsync(owner.signal);
      if (!isOwnerCurrent(owner)) return;
      for (const provider of missingProviders) {
        selections = setAccountSelection(selections, provider.id, data.providers[provider.id]?.active ?? null);
      }
      owner.sessionManager.appendCustomEntry(
        ACCOUNT_SELECTION_ENTRY_TYPE,
        createAccountSelectionEntryData(owner.sessionId, selections),
      );
      if (!isOwnerCurrent(owner)) return;
      owner.selections = selections;
    } catch {
      if (!isOwnerCurrent(owner)) return;
      owner.error =
        "Could not persist this Pi session's account selection. Choose an account or default from /accounts to retry.";
      ctx.ui.notify(
        owner.environmentAccount === undefined
          ? owner.error
          : "Could not persist the saved session selection, but PI_ACCOUNT remains active. Unset it and restart Pi to retry via /accounts.",
        owner.environmentAccount === undefined ? "error" : "warning",
      );
    }
  };

  const startSessionOwner = (ctx: ExtensionContext): SessionSelectionOwner => {
    const previous = sessionOwners.get(ctx.sessionManager);
    if (previous) {
      previous.failover?.dispose();
      previous.controller.abort(new DOMException("Accounts session replaced", "AbortError"));
      previous.results.clear();
      previous.selectionRevisions.clear();
      previous.activationRequests.clear();
      previous.activationTasks?.clear();
      previous.appliedIdentities.clear();
      previous.pendingInvalidations.clear();
      previous.abortProviders.clear();
      previous.syncTasks.clear();
      previous.pendingSyncTasks.clear();
      previous.startupTasks.clear();
      previous.startupCompletedProviders.clear();
      for (const coordinator of previous.coordinators.values()) coordinator.invalidate(ctx);
    }
    const controller = new AbortController();
    const environment = readEnvironmentAccount();
    const owner: SessionSelectionOwner = {
      context: ctx,
      // Pi exposes this as read-only to extensions, but the runtime context contains the concrete
      // session manager. Factory-bound pi.appendEntry() cannot target concurrent session owners.
      sessionManager: ctx.sessionManager as ExtensionContext["sessionManager"] & SessionEntryWriter,
      sessionId: ctx.sessionManager.getSessionId(),
      selections: cloneAccountSelections(Object.create(null) as ProviderAccountSelections),
      trialSelections: new Map(),
      environmentAccount: environment.account,
      environmentError: environment.error,
      selectionRevisions: new Map(),
      activationRequests: new Map(),
      activationTasks: new Map(),
      controller,
      signal: controller.signal,
      ready: Promise.resolve(),
      coordinators: new Map(providers.map((provider) => [provider.id, new RuntimeAuthCoordinator(pi, provider)])),
      results: new Map(),
      appliedIdentities: new Map(),
      pendingInvalidations: new Set(),
      preparingRun: false,
      abortProviders: new Set(),
      syncTasks: new Map(),
      pendingSyncTasks: new Map(),
      startupTask: Promise.resolve(),
      startupTasks: new Map(),
      startupCompletedProviders: new Set(),
    };
    sessionOwners.set(ctx.sessionManager, owner);
    if (owner.environmentError) ctx.ui.notify(owner.environmentError, "error");
    owner.failover = new AccountFailover(pi, store, owner, isOwnerCurrent, persistSelection, syncProvider);
    owner.ready = Promise.all([initializeOwner(owner, ctx), owner.failover.reload().catch(() => undefined)]).then(
      () => undefined,
    );
    return owner;
  };

  const ensureSessionOwner = async (ctx: ExtensionContext): Promise<SessionSelectionOwner> => {
    let owner = sessionOwners.get(ctx.sessionManager);
    if (!owner || owner.sessionId !== ctx.sessionManager.getSessionId()) {
      owner = startSessionOwner(ctx);
    }
    await owner.ready;
    return owner;
  };

  const persistSelection: PersistSelection = (owner, providerId, accountName, isCurrent, automatic = false) => {
    if (!isOwnerCurrent(owner) || !isCurrent() || owner.environmentAccount !== undefined || owner.environmentError) {
      return false;
    }
    let selections = owner.error
      ? providers.reduce<ProviderAccountSelections>(
          (current, provider) => setAccountSelection(current, provider.id, null),
          cloneAccountSelections(Object.create(null) as ProviderAccountSelections),
        )
      : owner.selections;
    selections = setAccountSelection(selections, providerId, accountName);
    owner.sessionManager.appendCustomEntry(
      ACCOUNT_SELECTION_ENTRY_TYPE,
      createAccountSelectionEntryData(owner.sessionId, selections),
    );
    if (!isOwnerCurrent(owner) || !isCurrent()) return false;
    owner.selections = selections;
    owner.trialSelections.delete(providerId);
    owner.selectionRevisions.set(providerId, (owner.selectionRevisions.get(providerId) ?? 0) + 1);
    if (!automatic) owner.failover?.explicitSelection(providerId);
    owner.error = undefined;
    const revision = owner.selectionRevisions.get(providerId);
    queueMicrotask(() => {
      try {
        if (
          !isOwnerCurrent(owner) ||
          owner.sessionManager.getSessionId() !== owner.sessionId ||
          owner.selectionRevisions.get(providerId) !== revision
        )
          return;
        pi.events.emit(ACCOUNTS_SELECTION_COMMITTED_CHANNEL, {
          session: owner.sessionManager,
          sessionId: owner.sessionId,
          providerId,
        });
      } catch {
        // A notification consumer must not interrupt the selected account's activation.
      }
    });
    return true;
  };

  const staleResult = (providerId: AccountProviderId): EnsureActiveProviderAuthResult => ({
    status: "inactive",
    providerId,
  });

  const syncProvider: SyncProvider = (
    providerId,
    ctx,
    owner,
    ownerSignal,
    model = ctx.model,
    beforeRequest = false,
  ) => {
    let task!: Promise<EnsureActiveProviderAuthResult>;
    task = (async () => {
      const adapter = requireAdapter(adapters, providerId);
      const coordinator = owner.coordinators.get(providerId);
      if (!coordinator) throw new Error(`Missing runtime coordinator for ${providerId}.`);
      if (!isOwnerCurrent(owner)) return staleResult(providerId);
      const signal = ownerSignal ? AbortSignal.any([owner.signal, ownerSignal]) : owner.signal;
      const selectionError =
        owner.environmentError ?? (owner.environmentAccount === undefined ? owner.error : undefined);
      let result = selectionError
        ? await coordinator.forceFailClosed(ctx, "unknown", new Error(selectionError))
        : await coordinator.ensureActive(
            ctx,
            store,
            owner.environmentAccount ?? owner.trialSelections.get(providerId) ?? owner.selections[providerId] ?? null,
            Date.now(),
            signal,
          );
      if (beforeRequest && signal.aborted) return staleResult(providerId);
      let identity: string | undefined;
      let latest = owner.syncTasks.get(providerId);
      if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
      if (latest && latest !== task) return latest;
      try {
        identity = coordinator.getAppliedAuthIdentity(ctx, result);
        const previousIdentity = owner.appliedIdentities.get(providerId);
        const shouldInvalidate =
          previousIdentity !== identity && !(previousIdentity === undefined && identity === "default");
        if (shouldInvalidate) owner.pendingInvalidations.add(providerId);
        // Pi cleanup is session-wide: background auth must not close another provider's live socket.
        if (
          owner.pendingInvalidations.has(providerId) &&
          ctx.model?.provider === providerId &&
          (beforeRequest || ctx.isIdle())
        ) {
          await adapter.invalidateConnections?.(owner.sessionId);
          if (beforeRequest && signal.aborted) return staleResult(providerId);
          latest = owner.syncTasks.get(providerId);
          if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
          if (latest && latest !== task) return latest;
          owner.pendingInvalidations.delete(providerId);
        } else if (
          shouldInvalidate &&
          previousIdentity !== undefined &&
          ctx.model?.provider === providerId &&
          !owner.preparingRun &&
          !ctx.signal?.aborted
        ) {
          // A later hook can change auth after turn_start. Abort instead of reusing an old thread.
          ctx.abort();
        }
        owner.appliedIdentities.set(providerId, identity);
      } catch (error) {
        if (beforeRequest && signal.aborted) return staleResult(providerId);
        latest = owner.syncTasks.get(providerId);
        if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
        if (latest && latest !== task) return latest;
        const credential = await selectedCredential(store, providerId, result, signal);
        if (beforeRequest && signal.aborted) return staleResult(providerId);
        latest = owner.syncTasks.get(providerId);
        if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
        if (latest && latest !== task) return latest;
        result = await coordinator.forceFailClosed(
          ctx,
          result.status === "inactive" ? "unknown" : result.accountName,
          error,
          credential,
        );
      }
      if (beforeRequest && signal.aborted) return staleResult(providerId);
      latest = owner.syncTasks.get(providerId);
      if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
      if (latest && latest !== task) return latest;
      coordinator.publishCredentialOffer(ctx, result, identity ?? "");
      owner.results.set(providerId, result);
      updateStatus(ctx, owner.results, model, hasEnvironmentSelection(owner));
      return result;
    })();
    owner.syncTasks.set(providerId, task);
    owner.pendingSyncTasks.set(providerId, task);
    const clearPending = () => {
      if (!isOwnerCurrent(owner) || owner.pendingSyncTasks.get(providerId) !== task) return;
      owner.pendingSyncTasks.delete(providerId);
    };
    void task.then(clearPending, clearPending);
    return task;
  };

  const startupProvider = (
    providerId: AccountProviderId,
    ctx: ExtensionContext,
    owner: SessionSelectionOwner,
  ): Promise<EnsureActiveProviderAuthResult> => {
    if (owner.startupCompletedProviders.has(providerId)) {
      return Promise.resolve(owner.results.get(providerId) ?? staleResult(providerId));
    }
    const existing = owner.startupTasks.get(providerId);
    if (existing) return existing;
    let task!: Promise<EnsureActiveProviderAuthResult>;
    task = syncProvider(providerId, ctx, owner).finally(() => {
      if (!isOwnerCurrent(owner) || owner.startupTasks.get(providerId) !== task) return;
      owner.startupTasks.delete(providerId);
      owner.startupCompletedProviders.add(providerId);
    });
    owner.startupTasks.set(providerId, task);
    return task;
  };

  const syncAll = async (ctx: ExtensionContext, owner: SessionSelectionOwner): Promise<void> => {
    for (const provider of providers) {
      if (!isOwnerCurrent(owner)) return;
      const result = await startupProvider(provider.id, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      if (result.status === "error" && (!hasEnvironmentSelection(owner) || ctx.model?.provider === provider.id)) {
        ctx.ui.notify(
          hasEnvironmentSelection(owner)
            ? `${provider.displayName} account selected by PI_ACCOUNT failed closed. Check that the account exists and its authentication is valid.`
            : `${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
          "error",
        );
      }
    }
    if (isOwnerCurrent(owner)) updateStatus(ctx, owner.results, ctx.model, hasEnvironmentSelection(owner));
  };

  const waitForCurrentProvider = async (providerId: AccountProviderId, owner: SessionSelectionOwner): Promise<void> => {
    await owner.ready;
    if (!isOwnerCurrent(owner)) return;
    let pending = owner.pendingSyncTasks.get(providerId);
    if (!pending) {
      pending = owner.startupCompletedProviders.has(providerId)
        ? syncProvider(providerId, owner.context, owner)
        : startupProvider(providerId, owner.context, owner);
    }
    while (true) {
      let rejected = false;
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        rejected = true;
        failure = error;
      }
      if (!isOwnerCurrent(owner)) return;
      const latest = owner.syncTasks.get(providerId);
      if (latest && latest !== pending) {
        pending = latest;
        continue;
      }
      if (rejected) throw failure;
      return;
    }
  };

  const startBackgroundSync = (ctx: ExtensionContext, owner: SessionSelectionOwner): void => {
    owner.startupTask = (async () => {
      try {
        await owner.ready;
        if (!isOwnerCurrent(owner)) return;
        await syncAll(ctx, owner);
      } catch (error) {
        if (!isOwnerCurrent(owner)) return;
        try {
          ctx.ui.notify(`Account startup activation failed: ${redactTokenText(errorMessage(error))}`, "error");
        } catch {
          // Detached startup must stay handled if the UI disappears during replacement or reload.
        }
      }
    })();
  };

  registerOAuthCredentialReadiness(pi, [
    {
      waitForCredential(data) {
        const request = parseCredentialReadinessRequest(data);
        if (!request) return;
        const owner = sessionOwners.get(request.session as ExtensionContext["sessionManager"]);
        const providerId = toProviderId(request.provider);
        if (!owner || !providerId) return;
        const pending = waitForCurrentProvider(providerId, owner);
        try {
          request.waitUntil(pending);
        } catch {
          void pending.catch(() => undefined);
        }
      },
    },
  ]);

  registerAccountsProtocol(
    pi,
    async () => {
      const data = await store.readAsync();
      return {
        providers: providers.map((adapter) => {
          const state = data.providers[adapter.id];
          return {
            providerId: adapter.id,
            displayName: adapter.displayName,
            accounts: Object.entries(state?.accounts ?? {}).map(([name, credential]) => ({
              name,
              kind: credential.type === "api_key" ? ("api-key" as const) : ("oauth" as const),
            })),
            ...(state?.active ? { defaultAccount: state.active } : {}),
          };
        }),
      };
    },
    createAccountActivation(
      store,
      adapters,
      (session) => sessionOwners.get(session as ExtensionContext["sessionManager"]),
      isOwnerCurrent,
      persistSelection,
      syncProvider,
    ),
  );

  pi.registerCommand(
    "accounts",
    createAccountCommand(
      store,
      adapters,
      syncProvider,
      persistSelection,
      ensureSessionOwner,
      (owner) => ({
        signal: owner.signal,
        isCurrent: () => isOwnerCurrent(owner),
      }),
      (owner) => ({
        changed: async () => {
          await owner.failover?.reload();
        },
        status: (providerId) => owner.failover?.status(providerId) ?? "Failover off.",
      }),
    ),
  );

  pi.on("session_start", (_event, ctx) => {
    const owner = startSessionOwner(ctx);
    if (migrationNotice) {
      ctx.ui.notify(migrationNotice, "warning");
      migrationNotice = undefined;
    }
    startBackgroundSync(ctx, owner);
  });

  pi.on("model_select", async (event, ctx) => {
    const owner = await ensureSessionOwner(ctx);
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(event.model.provider);
    if (providerId) {
      const result = await syncProvider(providerId, ctx, owner, undefined, event.model);
      if (
        isOwnerCurrent(owner) &&
        ctx.model?.provider === providerId &&
        owner.pendingInvalidations.has(providerId) &&
        !owner.preparingRun &&
        !ctx.isIdle() &&
        !ctx.signal?.aborted
      ) {
        ctx.abort();
      }
      if (isOwnerCurrent(owner) && result.status === "error" && hasEnvironmentSelection(owner)) {
        ctx.ui.notify(
          `${requireAdapter(adapters, providerId).displayName} account selected by PI_ACCOUNT failed closed. Check that the account exists and its authentication is valid.`,
          "error",
        );
      }
    } else updateStatus(ctx, owner.results, event.model, hasEnvironmentSelection(owner));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const owner = await ensureSessionOwner(ctx);
    owner.abortProviders.clear();
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(ctx.model?.provider);
    if (!providerId) return;
    owner.preparingRun = true;
    try {
      const result = owner.startupCompletedProviders.has(providerId)
        ? await syncProvider(providerId, ctx, owner)
        : await startupProvider(providerId, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      const coordinator = owner.coordinators.get(providerId);
      if (result.status === "error") owner.abortProviders.add(providerId);
      if (result.status === "active" && ctx.model && coordinator && !coordinator.isModelAvailable(ctx.model.id)) {
        owner.abortProviders.add(providerId);
        ctx.ui.notify(
          hasEnvironmentSelection(owner)
            ? `${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to the account selected by PI_ACCOUNT.`
            : `${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
          "error",
        );
      }
    } catch (error) {
      owner.abortProviders.add(providerId);
      throw error;
    } finally {
      owner.preparingRun = false;
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner) return;
    await owner.ready;
    if (!isOwnerCurrent(owner)) return;
    await prepareAccountRequest(ctx, owner, isOwnerCurrent, syncProvider);
    if (!isOwnerCurrent(owner) || ctx.signal?.aborted) return;
    await owner.failover?.prepare(ctx);
    if (isOwnerCurrent(owner) && !ctx.signal?.aborted)
      await prepareAccountRequest(ctx, owner, isOwnerCurrent, syncProvider);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (owner) await owner.failover?.settled(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner) {
      setStatus(ctx, undefined);
      return;
    }
    sessionOwners.delete(ctx.sessionManager);
    owner.failover?.dispose();
    owner.controller.abort(new DOMException("Accounts session shut down", "AbortError"));
    owner.results.clear();
    owner.selectionRevisions.clear();
    owner.activationRequests.clear();
    owner.activationTasks?.clear();
    owner.appliedIdentities.clear();
    owner.pendingInvalidations.clear();
    owner.abortProviders.clear();
    owner.syncTasks.clear();
    owner.pendingSyncTasks.clear();
    owner.startupTasks.clear();
    owner.startupCompletedProviders.clear();
    await Promise.allSettled(
      [...owner.coordinators.values()].map(async (coordinator) => {
        coordinator.invalidate(ctx, false);
        await coordinator.clear(ctx, true);
      }),
    );
    setStatus(ctx, undefined);
  });
}

function validateProviderSet(providers: readonly AccountProviderAdapter[], requireAll: boolean): void {
  const ids = new Set<AccountProviderId>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Duplicate account provider: ${provider.id}`);
    ids.add(provider.id);
  }
  if (!requireAll) return;
  for (const id of SUPPORTED_PROVIDER_IDS) {
    if (!ids.has(id)) throw new Error(`Missing required account provider: ${id}`);
  }
}

function requireAdapter(
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  providerId: AccountProviderId,
): AccountProviderAdapter {
  const adapter = adapters.get(providerId);
  if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
  return adapter;
}

function toProviderId(value: string | undefined): AccountProviderId | undefined {
  return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

async function selectedCredential(
  store: AccountStore,
  providerId: AccountProviderId,
  result: EnsureActiveProviderAuthResult,
  signal?: AbortSignal,
): Promise<StoredCredential | undefined> {
  if (result.status === "inactive") return undefined;
  try {
    const state = await store.readProviderAsync(providerId, signal);
    return getOwnCredential(state.accounts, result.accountName);
  } catch {
    return undefined;
  }
}

function updateStatus(
  ctx: ExtensionContext,
  results: Map<AccountProviderId, EnsureActiveProviderAuthResult>,
  model = ctx.model,
  fromEnvironment = false,
): void {
  const providerId = toProviderId(model?.provider);
  const result = providerId ? results.get(providerId) : undefined;
  if (!result || result.status === "inactive") {
    setStatus(ctx, undefined);
    return;
  }
  if (result.status === "active") {
    setStatus(ctx, fromEnvironment ? "account:PI_ACCOUNT" : `account:${result.accountName}`);
    return;
  }
  setStatus(ctx, fromEnvironment ? "account:PI_ACCOUNT auth error" : `account:${result.accountName} auth error`);
}

function readEnvironmentAccount(): { account?: string; error?: string } {
  const value = process.env.PI_ACCOUNT;
  if (value === undefined) return {};
  const parsed = parseAccountName(value);
  if (parsed.ok && !isDefaultPiLoginArg(parsed.name)) return { account: parsed.name };
  return {
    error:
      "PI_ACCOUNT must name a saved account (1-64 letters, numbers, dots, underscores, or hyphens; not default). Unset it and restart Pi to restore session selection.",
  };
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
  try {
    ctx.ui.setStatus(ACCOUNTS_STATUS_KEY, value);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("This extension ctx is stale after session replacement or reload")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
