import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AccountStore,
  defineOwn,
  defineOwnMap,
  getOwnCredential,
  normalizeApiKeyCredential,
  normalizeStoredCredential,
  parseAccountName,
  type StoredCredential,
} from "./account-store.js";
import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./accounts.js";
import type { AccountProviderId } from "./oauth.js";
import { type AccountProviderAdapter, loginWithOAuthUI } from "./oauth.js";
import { type EnsureActiveProviderAuthResult, redactTokenText } from "./runtime-auth.js";

export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

export function createAccountCommand(
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  syncProvider: SyncProvider,
  persistSelection: PersistSelection,
  ensureSessionOwner: (ctx: ExtensionContext) => Promise<SessionSelectionOwner>,
  getMenuOwner: (owner: SessionSelectionOwner) => { signal: AbortSignal; isCurrent(): boolean },
  getFailoverMenu?: (owner: SessionSelectionOwner) => {
    changed(providerId: string): Promise<void>;
    status(providerId: string): string;
  },
) {
  return {
    description: "Open the interactive OAuth and API key account manager",
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
          login: (adapter, name, signal, isCurrent, method) =>
            loginAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent, method),
          switch: (adapter, name, signal, isCurrent) =>
            switchAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent),
          remove: (adapter, name, signal, isCurrent) =>
            removeAccount(ctx, store, adapter, name, signal, syncProvider, persistSelection, owner, isCurrent),
        },
        menuOwner,
        getFailoverMenu?.(owner),
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
  method: "oauth" | "api_key" = "oauth",
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
  let enteredKey: string | undefined;
  try {
    let credential: StoredCredential;
    if (method === "api_key") {
      if (!adapter.supportsApiKey) throw new Error(`${adapter.displayName} does not support API keys.`);
      enteredKey = await ctx.ui.input(`${adapter.displayName} API key (visible input):`, "", { signal });
      if (enteredKey === undefined || !isCurrent() || signal.aborted) return;
      credential = normalizeApiKeyCredential(enteredKey);
    } else {
      credential = normalizeStoredCredential(await loginWithOAuthUI(ctx, adapter, signal), parsed.name);
    }
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
    if (!hasEnvironmentSelection(session) && !persistSelection(session, adapter.id, parsed.name, isCurrent)) return;
    const result = await syncProvider(adapter.id, ctx, session, signal);
    if (!isCurrent()) return;
    ctx.ui.notify(
      hasEnvironmentSelection(session)
        ? `Saved ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still controls this process's selection.${result.status === "error" ? " Authentication failed closed; check the selected account." : ""}`
        : formatActivationMessage("Logged in", adapter, parsed.name, result),
      result.status === "error" ? "error" : "info",
    );
  } catch (error) {
    if (!isCurrent()) return;
    const message = redactTokenText(errorMessage(error), enteredKey ? [enteredKey] : []);
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
  if (hasEnvironmentSelection(session)) {
    ctx.ui.notify(
      "PI_ACCOUNT controls this process's account selection. Unset it and restart Pi to switch accounts.",
      "warning",
    );
    return;
  }
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
  if (hasEnvironmentSelection(session)) {
    if (session.environmentAccount === parsed.name) {
      const result = await syncProvider(adapter.id, ctx, session, signal);
      if (!isCurrent()) return;
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still selects this name; ${result.status === "error" ? "requests will fail closed until the account is restored or Pi is restarted without PI_ACCOUNT." : "check the effective selection."}`,
        result.status === "error" ? "error" : "warning",
      );
    } else {
      ctx.ui.notify(
        `Removed ${adapter.displayName} account "${parsed.name}". PI_ACCOUNT still controls this process.`,
        "info",
      );
    }
    return;
  }
  if (session.trialSelections.get(adapter.id) === parsed.name) session.failover?.cancelTrial(adapter.id);
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

export function isDefaultPiLoginArg(value: string): boolean {
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

export function hasEnvironmentSelection(owner: SessionSelectionOwner): boolean {
  return owner.environmentAccount !== undefined || owner.environmentError !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
