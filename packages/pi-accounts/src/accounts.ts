import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AccountStore,
  consumeMigrationNotice,
  defineOwn,
  defineOwnMap,
  getOwnCredential,
  normalizeStoredCredential,
  parseAccountName,
  type StoredOAuthCredential,
} from "./account-store.js";
import {
  type AccountProviderAdapter,
  type AccountProviderId,
  createBuiltinProviderAdapters,
  loginWithOAuthUI,
  SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import { parseCredentialRequest, registerOAuthCredentialSource } from "./oauth-credential-source.js";
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
  type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

export type AccountsDependencies = {
  store?: AccountStore;
  providers?: readonly AccountProviderAdapter[];
  closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
};

type SessionEntryWriter = {
  appendCustomEntry(customType: string, data?: unknown): string;
};

type SessionSelectionOwner = {
  sessionManager: ExtensionContext["sessionManager"] & SessionEntryWriter;
  sessionId: string;
  selections: ProviderAccountSelections;
  error?: string;
  controller: AbortController;
  signal: AbortSignal;
  ready: Promise<void>;
  coordinators: Map<AccountProviderId, RuntimeAuthCoordinator>;
  results: Map<AccountProviderId, EnsureActiveProviderAuthResult>;
  appliedIdentities: Map<AccountProviderId, string>;
  abortProviders: Set<AccountProviderId>;
  syncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
};

type SyncProvider = (
  providerId: AccountProviderId,
  ctx: ExtensionContext,
  owner: SessionSelectionOwner,
  ownerSignal?: AbortSignal,
  model?: ExtensionContext["model"],
) => Promise<EnsureActiveProviderAuthResult>;

type PersistSelection = (
  owner: SessionSelectionOwner,
  providerId: AccountProviderId,
  accountName: string | null,
  isCurrent: () => boolean,
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
      ctx.ui.notify(restored.message, "error");
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
      const data = await store.readAsync();
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
      ctx.ui.notify(owner.error, "error");
    }
  };

  const startSessionOwner = (ctx: ExtensionContext): SessionSelectionOwner => {
    const previous = sessionOwners.get(ctx.sessionManager);
    if (previous) {
      previous.controller.abort(new DOMException("Accounts session replaced", "AbortError"));
      previous.results.clear();
      previous.appliedIdentities.clear();
      previous.abortProviders.clear();
      previous.syncTasks.clear();
      for (const coordinator of previous.coordinators.values()) coordinator.invalidate(ctx);
    }
    const controller = new AbortController();
    const owner: SessionSelectionOwner = {
      // Pi exposes this as read-only to extensions, but the runtime context contains the concrete
      // session manager. Factory-bound pi.appendEntry() cannot target concurrent session owners.
      sessionManager: ctx.sessionManager as ExtensionContext["sessionManager"] & SessionEntryWriter,
      sessionId: ctx.sessionManager.getSessionId(),
      selections: cloneAccountSelections(Object.create(null) as ProviderAccountSelections),
      controller,
      signal: controller.signal,
      ready: Promise.resolve(),
      coordinators: new Map(providers.map((provider) => [provider.id, new RuntimeAuthCoordinator(pi, provider)])),
      results: new Map(),
      appliedIdentities: new Map(),
      abortProviders: new Set(),
      syncTasks: new Map(),
    };
    sessionOwners.set(ctx.sessionManager, owner);
    owner.ready = initializeOwner(owner, ctx);
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

  const persistSelection: PersistSelection = (owner, providerId, accountName, isCurrent) => {
    if (!isOwnerCurrent(owner) || !isCurrent()) return false;
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
    owner.error = undefined;
    return true;
  };

  const staleResult = (providerId: AccountProviderId): EnsureActiveProviderAuthResult => ({
    status: "inactive",
    providerId,
  });

  const syncProvider: SyncProvider = (providerId, ctx, owner, ownerSignal, model = ctx.model) => {
    let task!: Promise<EnsureActiveProviderAuthResult>;
    task = (async () => {
      const adapter = requireAdapter(adapters, providerId);
      const coordinator = owner.coordinators.get(providerId);
      if (!coordinator) throw new Error(`Missing runtime coordinator for ${providerId}.`);
      if (!isOwnerCurrent(owner)) return staleResult(providerId);
      const signal = ownerSignal ? AbortSignal.any([owner.signal, ownerSignal]) : owner.signal;
      let result = owner.error
        ? await coordinator.forceFailClosed(ctx, "unknown", new Error(owner.error))
        : await coordinator.ensureActive(ctx, store, owner.selections[providerId] ?? null, Date.now(), signal);
      let identity: string | undefined;
      let latest = owner.syncTasks.get(providerId);
      if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
      if (latest && latest !== task) return latest;
      try {
        identity = coordinator.getAppliedAuthIdentity(ctx, result);
        const previousIdentity = owner.appliedIdentities.get(providerId);
        const shouldInvalidate =
          previousIdentity !== identity && !(previousIdentity === undefined && identity === "default");
        if (shouldInvalidate) {
          await adapter.invalidateConnections?.(owner.sessionId);
          latest = owner.syncTasks.get(providerId);
          if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
          if (latest && latest !== task) return latest;
        }
        owner.appliedIdentities.set(providerId, identity);
      } catch (error) {
        latest = owner.syncTasks.get(providerId);
        if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
        if (latest && latest !== task) return latest;
        const credential = await selectedCredential(store, providerId, result);
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
      latest = owner.syncTasks.get(providerId);
      if (!isOwnerCurrent(owner)) return latest && latest !== task ? latest : staleResult(providerId);
      if (latest && latest !== task) return latest;
      coordinator.publishCredentialOffer(ctx, result, identity ?? "");
      owner.results.set(providerId, result);
      updateStatus(ctx, owner.results, model);
      return result;
    })();
    owner.syncTasks.set(providerId, task);
    return task;
  };

  const syncAll = async (ctx: ExtensionContext, owner: SessionSelectionOwner): Promise<void> => {
    for (const provider of providers) {
      if (!isOwnerCurrent(owner)) return;
      const result = await syncProvider(provider.id, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      if (result.status === "error") {
        ctx.ui.notify(
          `${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
          "error",
        );
      }
    }
    if (isOwnerCurrent(owner)) updateStatus(ctx, owner.results);
  };

  pi.registerCommand(
    "accounts",
    createAccountCommand(store, adapters, syncProvider, persistSelection, ensureSessionOwner, (owner) => ({
      signal: owner.signal,
      isCurrent: () => isOwnerCurrent(owner),
    })),
  );

  pi.on("session_start", async (_event, ctx) => {
    const owner = startSessionOwner(ctx);
    if (migrationNotice) {
      ctx.ui.notify(migrationNotice, "warning");
      migrationNotice = undefined;
    }
    await owner.ready;
    if (isOwnerCurrent(owner)) await syncAll(ctx, owner);
  });

  pi.on("model_select", async (event, ctx) => {
    const owner = await ensureSessionOwner(ctx);
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(event.model.provider);
    if (providerId) await syncProvider(providerId, ctx, owner, undefined, event.model);
    else updateStatus(ctx, owner.results, event.model);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const owner = await ensureSessionOwner(ctx);
    owner.abortProviders.clear();
    if (!isOwnerCurrent(owner)) return;
    const providerId = toProviderId(ctx.model?.provider);
    if (!providerId) return;
    try {
      const result = await syncProvider(providerId, ctx, owner);
      if (!isOwnerCurrent(owner)) return;
      const coordinator = owner.coordinators.get(providerId);
      if (result.status === "error") owner.abortProviders.add(providerId);
      if (result.status === "active" && ctx.model && coordinator && !coordinator.isModelAvailable(ctx.model.id)) {
        owner.abortProviders.add(providerId);
        ctx.ui.notify(
          `${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
          "error",
        );
      }
    } catch (error) {
      owner.abortProviders.add(providerId);
      throw error;
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner || !isOwnerCurrent(owner)) return;
    const providerId = toProviderId(ctx.model?.provider);
    if (!providerId || !owner.abortProviders.has(providerId)) return;
    owner.abortProviders.delete(providerId);
    ctx.abort();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = sessionOwners.get(ctx.sessionManager);
    if (!owner) {
      setStatus(ctx, undefined);
      return;
    }
    sessionOwners.delete(ctx.sessionManager);
    owner.controller.abort(new DOMException("Accounts session shut down", "AbortError"));
    owner.results.clear();
    owner.appliedIdentities.clear();
    owner.abortProviders.clear();
    owner.syncTasks.clear();
    await Promise.allSettled(
      [...owner.coordinators.values()].map(async (coordinator) => {
        coordinator.invalidate(ctx, false);
        await coordinator.clear(ctx, true);
      }),
    );
    setStatus(ctx, undefined);
  });
}

function createAccountCommand(
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  syncProvider: SyncProvider,
  persistSelection: PersistSelection,
  ensureSessionOwner: (ctx: ExtensionContext) => Promise<SessionSelectionOwner>,
  getMenuOwner: (owner: SessionSelectionOwner) => { signal: AbortSignal; isCurrent(): boolean },
) {
  return {
    description: "Open the interactive OAuth account manager",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const owner = await ensureSessionOwner(ctx);
      const menuOwner = getMenuOwner(owner);
      if (!menuOwner.isCurrent()) return;
      const { showAccountsMenu } = await import("./account-menu.js");
      if (!menuOwner.isCurrent()) return;
      await showAccountsMenu(
        ctx,
        store,
        adapters,
        owner,
        {
          login: (adapter, name, signal, isCurrent) =>
            loginAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent),
          switch: (adapter, name, signal, isCurrent) =>
            switchAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent),
          remove: (adapter, name, signal, isCurrent) =>
            removeAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent),
        },
        menuOwner,
      );
    },
  };
}

async function loginAccount(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapter: AccountProviderAdapter,
  nameArg: string,
  signal: AbortSignal,
  syncProvider: SyncProvider,
  persistSelection: PersistSelection,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
): Promise<void> {
  const parsed = parseAccountName(nameArg);
  if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
  if (isDefaultPiLoginArg(parsed.name)) {
    ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("Account login requires interactive UI.", "error");
    return;
  }
  const state = await store.readProviderAsync(adapter.id);
  if (!isCurrent()) return;
  if (getOwnCredential(state.accounts, parsed.name)) {
    const confirmed = await ctx.ui.confirm(
      "Replace account",
      `${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
    );
    if (!confirmed || !isCurrent()) return;
  }
  ctx.ui.notify(`Starting ${adapter.displayName} login for "${parsed.name}".`, "info");
  let credentialSaved = false;
  try {
    const credential = normalizeStoredCredential(await loginWithOAuthUI(ctx, adapter, signal), parsed.name);
    if (!isCurrent()) return;
    await store.updateProvider(adapter.id, (state) =>
      isCurrent()
        ? {
            ...state,
            accounts: defineOwn(state.accounts, parsed.name, credential),
          }
        : state,
    );
    if (!isCurrent()) return;
    credentialSaved = true;
    if (!persistSelection(session, adapter.id, parsed.name, isCurrent)) return;
    const result = await syncProvider(adapter.id, ctx, session, signal);
    if (!isCurrent()) return;
    ctx.ui.notify(
      formatActivationMessage("Logged in", adapter, parsed.name, result),
      result.status === "active" ? "info" : "error",
    );
  } catch (error) {
    if (!isCurrent()) return;
    const message = redactTokenText(errorMessage(error));
    ctx.ui.notify(
      credentialSaved
        ? `${adapter.displayName} account "${parsed.name}" was saved, but this session could not select it: ${message}`
        : `${adapter.displayName} login failed: ${message}`,
      "error",
    );
  }
}

async function switchAccount(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapter: AccountProviderAdapter,
  nameArg: string,
  signal: AbortSignal,
  syncProvider: SyncProvider,
  persistSelection: PersistSelection,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const name = nameArg.trim();
  if (!name) {
    ctx.ui.notify(`Select a ${adapter.displayName} account from /accounts.`, "warning");
    return;
  }
  if (isDefaultPiLoginArg(name)) {
    try {
      if (!persistSelection(session, adapter.id, null, isCurrent)) return;
    } catch (error) {
      if (!isCurrent()) return;
      ctx.ui.notify(
        `Could not save the default ${adapter.displayName} selection for this session: ${redactTokenText(errorMessage(error))}`,
        "error",
      );
      return;
    }
    const result = await syncProvider(adapter.id, ctx, session, signal);
    if (!isCurrent()) return;
    if (result.status === "error") {
      ctx.ui.notify(
        `Could not restore default Pi ${adapter.displayName} login; requests will fail closed: ${result.message}`,
        "error",
      );
      return;
    }
    ctx.ui.notify(`Using default Pi ${adapter.displayName} login.`, "info");
    return;
  }
  const parsed = parseAccountName(name);
  if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
  const state = await store.readProviderAsync(adapter.id);
  if (!isCurrent()) return;
  if (!getOwnCredential(state.accounts, parsed.name)) {
    ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
    return;
  }
  try {
    if (!persistSelection(session, adapter.id, parsed.name, isCurrent)) return;
  } catch (error) {
    if (!isCurrent()) return;
    ctx.ui.notify(
      `Could not save ${adapter.displayName} account "${parsed.name}" for this session: ${redactTokenText(errorMessage(error))}`,
      "error",
    );
    return;
  }
  const result = await syncProvider(adapter.id, ctx, session, signal);
  if (!isCurrent()) return;
  ctx.ui.notify(
    formatActivationMessage("Activated", adapter, parsed.name, result),
    result.status === "active" ? "info" : "error",
  );
}

async function removeAccount(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapter: AccountProviderAdapter,
  nameArg: string,
  signal: AbortSignal,
  syncProvider: SyncProvider,
  persistSelection: PersistSelection,
  session: SessionSelectionOwner,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const parsed = parseAccountName(nameArg);
  if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
  let removed = false;
  await store.updateProvider(adapter.id, (state) => {
    if (!isCurrent() || !getOwnCredential(state.accounts, parsed.name)) return state;
    removed = true;
    const accounts = defineOwnMap(state.accounts);
    delete accounts[parsed.name];
    return {
      ...state,
      active: state.active === parsed.name ? undefined : state.active,
      accounts,
    };
  });
  if (!isCurrent()) return;
  if (!removed) {
    ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
    return;
  }
  const removedSelection = !session.error && session.selections[adapter.id] === parsed.name;
  if (removedSelection) {
    try {
      if (!persistSelection(session, adapter.id, null, isCurrent)) return;
    } catch (error) {
      if (!isCurrent()) return;
      const result = await syncProvider(adapter.id, ctx, session, signal);
      if (!isCurrent()) return;
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}", but this session could not save its default selection and will fail closed: ${redactTokenText(errorMessage(error))}${result.status === "error" ? ` (${result.message})` : ""}`,
        "error",
      );
      return;
    }
    const result = await syncProvider(adapter.id, ctx, session, signal);
    if (!isCurrent()) return;
    if (result.status === "error") {
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}", but default auth restoration failed closed: ${result.message}`,
        "error",
      );
      return;
    }
  }
  ctx.ui.notify(`Removed ${adapter.displayName} account "${parsed.name}".`, "info");
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

function isDefaultPiLoginArg(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "default" || normalized === "--default" || normalized === DEFAULT_PI_LOGIN_LABEL;
}

function formatActivationMessage(
  action: "Logged in" | "Activated",
  adapter: AccountProviderAdapter,
  name: string,
  result: EnsureActiveProviderAuthResult,
): string {
  if (result.status !== "inactive" && result.accountName !== "unknown" && result.accountName !== name) {
    return `${action} ${adapter.displayName} account "${name}" was superseded by "${result.accountName}" before activation.`;
  }
  if (result.status === "error") {
    return `${action} ${adapter.displayName} account "${name}", but authentication failed; requests will fail closed: ${result.message}`;
  }
  if (result.status === "inactive") {
    return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
  }
  return `${action} ${adapter.displayName} account "${name}".`;
}

async function selectedCredential(
  store: AccountStore,
  providerId: AccountProviderId,
  result: EnsureActiveProviderAuthResult,
): Promise<StoredOAuthCredential | undefined> {
  if (result.status === "inactive") return undefined;
  try {
    const state = await store.readProviderAsync(providerId);
    return getOwnCredential(state.accounts, result.accountName);
  } catch {
    return undefined;
  }
}

function updateStatus(
  ctx: ExtensionContext,
  results: Map<AccountProviderId, EnsureActiveProviderAuthResult>,
  model = ctx.model,
): void {
  const providerId = toProviderId(model?.provider);
  const result = providerId ? results.get(providerId) : undefined;
  if (!result || result.status === "inactive") {
    setStatus(ctx, undefined);
    return;
  }
  if (result.status === "active") {
    setStatus(ctx, `account:${result.accountName}`);
    return;
  }
  setStatus(ctx, `account:${result.accountName} auth error`);
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
