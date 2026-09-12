import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { defineOwn, defineOwnMap, parseAccountName } from "./account-store.js";

export const ACCOUNT_SELECTION_ENTRY_TYPE = "pi-accounts-selection";
const ACCOUNT_SELECTION_VERSION = 1;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROVIDER_SELECTIONS = 1_000;

export type ProviderAccountSelections = Record<string, string | null>;

export type AccountSelectionEntryData = {
  version: 1;
  sessionId: string;
  providers: ProviderAccountSelections;
};

export type RestoredAccountSelections =
  | { status: "missing" }
  | { status: "loaded"; selections: ProviderAccountSelections }
  | { status: "invalid"; message: string };

export function restoreAccountSelections(
  entries: readonly SessionEntry[],
  sessionId: string,
): RestoredAccountSelections {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ACCOUNT_SELECTION_ENTRY_TYPE) continue;
    if (!isRecord(entry.data) || entry.data.sessionId !== sessionId) continue;
    try {
      return { status: "loaded", selections: parseSelectionEntryData(entry.data).providers };
    } catch {
      return {
        status: "invalid",
        message:
          "The saved account selection for this Pi session is invalid. Choose an account or default from /accounts to recover.",
      };
    }
  }
  return { status: "missing" };
}

export function createAccountSelectionEntryData(
  sessionId: string,
  selections: ProviderAccountSelections,
): AccountSelectionEntryData {
  if (!sessionId) throw new Error("Cannot persist account selection without a Pi session ID.");
  return {
    version: ACCOUNT_SELECTION_VERSION,
    sessionId,
    providers: normalizeSelections(selections),
  };
}

export function setAccountSelection(
  selections: ProviderAccountSelections,
  providerId: string,
  accountName: string | null,
): ProviderAccountSelections {
  return defineOwn(selections, providerId, accountName);
}

export function cloneAccountSelections(selections: ProviderAccountSelections): ProviderAccountSelections {
  return defineOwnMap(selections);
}

function parseSelectionEntryData(value: Record<string, unknown>): AccountSelectionEntryData {
  if (value.version !== ACCOUNT_SELECTION_VERSION) {
    throw new Error("Unsupported account selection version.");
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw new Error("Invalid account selection session ID.");
  }
  if (!isRecord(value.providers)) throw new Error("Invalid account selections.");
  return {
    version: ACCOUNT_SELECTION_VERSION,
    sessionId: value.sessionId,
    providers: normalizeSelections(value.providers),
  };
}

function normalizeSelections(value: Record<string, unknown>): ProviderAccountSelections {
  const entries = Object.entries(value);
  if (entries.length > MAX_PROVIDER_SELECTIONS) throw new Error("Too many account selections.");
  const selections = Object.create(null) as ProviderAccountSelections;
  for (const [providerId, accountName] of entries) {
    if (!PROVIDER_ID_RE.test(providerId)) throw new Error("Invalid account selection provider.");
    if (accountName === null) {
      Object.defineProperty(selections, providerId, {
        configurable: true,
        enumerable: true,
        value: null,
        writable: true,
      });
      continue;
    }
    if (typeof accountName !== "string") throw new Error("Invalid selected account.");
    const parsed = parseAccountName(accountName);
    if (!parsed.ok) throw new Error("Invalid selected account.");
    Object.defineProperty(selections, providerId, {
      configurable: true,
      enumerable: true,
      value: parsed.name,
      writable: true,
    });
  }
  return selections;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
