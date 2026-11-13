import { type AccountStore, type ProviderAccountsData, parseAccountName } from "./account-store.js";
import { type AccountProviderId, SUPPORTED_PROVIDER_IDS } from "./oauth.js";

export type FailoverSettings = {
  enabled: boolean;
  accounts: string[];
  minRemainingPercent: number;
};

function defaults(): FailoverSettings {
  return { enabled: false, accounts: [], minRemainingPercent: 5 };
}

/** Invalid optional policy never invalidates the provider's credentials. */
export function readFailoverSettings(state: ProviderAccountsData): { settings: FailoverSettings; error?: string } {
  if (!Object.hasOwn(state, "fallback")) return { settings: defaults() };
  try {
    return { settings: validate(state.fallback) };
  } catch (error) {
    return {
      settings: defaults(),
      error: error instanceof Error ? error.message : "Invalid account failover settings.",
    };
  }
}

/** Save only policy fields through the credential store's existing queue and private lock. */
export async function saveFailoverSettings(
  store: AccountStore,
  providerId: string,
  settings: FailoverSettings,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  // Detach caller-owned arrays before this operation waits in the store queue.
  const next = validate(settings);
  await updateFailoverSettings(store, providerId, () => next, signal, isCurrent);
}

/** Apply one UI change to the latest policy inside the store's locked mutation. */
export async function updateFailoverSettings(
  store: AccountStore,
  providerId: string,
  change: (settings: FailoverSettings, state: ProviderAccountsData) => FailoverSettings,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<FailoverSettings> {
  if (!(SUPPORTED_PROVIDER_IDS as readonly string[]).includes(providerId)) {
    throw new Error("Unsupported account failover provider.");
  }
  let saved = defaults();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (!isCurrent()) throw new DOMException("Account settings owner changed", "AbortError");
  };
  assertCurrent();
  await store.updateProviderAsync(
    providerId as AccountProviderId,
    async (state) => {
      assertCurrent();
      const current = readFailoverSettings(state);
      if (current.error) {
        throw new Error("Invalid failover settings. Repair the provider's fallback block manually before saving.");
      }
      const previousAccounts = new Set(current.settings.accounts);
      const wasEnabled = current.settings.enabled;
      const next = validate(change(current.settings, state));
      assertCurrent();
      // Retain stale references for disable and sequential repair, but never add missing accounts.
      for (const name of next.accounts) {
        if (!previousAccounts.has(name) && !Object.hasOwn(state.accounts, name)) {
          throw new Error("A backup account no longer exists under this provider. Refresh Settings and try again.");
        }
      }
      if (next.enabled && !wasEnabled && !next.accounts.some((name) => Object.hasOwn(state.accounts, name))) {
        throw new Error("Add at least one available saved backup account before enabling failover.");
      }
      saved = next;
      return { ...state, fallback: { ...(isRecord(state.fallback) ? state.fallback : {}), ...next } };
    },
    signal,
  );
  return saved;
}

function validate(value: unknown): FailoverSettings {
  if (!isRecord(value)) throw new Error("Invalid failover settings: fallback must be an object.");
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid failover settings: enabled must be a boolean.");
  }
  if (!Array.isArray(value.accounts)) {
    throw new Error("Invalid failover settings: accounts must be an ordered array.");
  }
  const accounts: string[] = [];
  for (const name of value.accounts) {
    const parsed = typeof name === "string" ? parseAccountName(name) : undefined;
    if (!parsed?.ok || parsed.name !== name || name === "default") {
      throw new Error("Invalid failover settings: use exact saved account names; default is not a backup.");
    }
    if (accounts.includes(name)) throw new Error("Invalid failover settings: backup accounts must not repeat.");
    accounts.push(name);
  }
  const threshold = value.minRemainingPercent === undefined ? 5 : value.minRemainingPercent;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold >= 100) {
    throw new Error("Invalid failover settings: minRemainingPercent must be finite, at least 0, and less than 100.");
  }
  if (value.enabled && accounts.length === 0) {
    throw new Error("Invalid failover settings: add at least one backup account before enabling failover.");
  }
  return { enabled: value.enabled, accounts, minRemainingPercent: threshold };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
