import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ACCOUNTS_TOPOLOGY_CHANNEL = "accounts:topology:v1";
export const ACCOUNTS_ACTIVATION_CHANNEL = "accounts:activation:v1";
export const ACCOUNTS_SELECTION_COMMITTED_CHANNEL = "accounts:selection-committed:v1";

export type AccountsSelectionCommittedEvent = {
  session: object;
  sessionId: string;
  providerId: string;
};

export type AccountTopologyEntry = { name: string; kind: "oauth" | "api-key" };
export type ProviderAccountTopology = {
  providerId: string;
  displayName: string;
  accounts: AccountTopologyEntry[];
  /** User-wide named default adopted by new sessions, not the current selection. */
  defaultAccount?: string;
};
export type AccountTopology = { providers: ProviderAccountTopology[] };
export type AccountActivationErrorCode =
  | "account_not_found"
  | "authentication_failed"
  | "store_unavailable"
  | "effective_auth_conflict"
  | "model_unavailable"
  | "activation_superseded"
  | "session_unavailable"
  | "provider_unsupported"
  | "cancelled"
  | "activation_failed";
export type AccountActivationResult =
  | { status: "active"; providerId: string; accountName: string }
  | { status: "inactive"; providerId: string; accountName: null }
  | { status: "error"; providerId: string; accountName: string | null; code: AccountActivationErrorCode };
export type AccountsTopologyRequest = { reply(topology: AccountTopology): void };
export type AccountsActivationRequest = {
  /** The exact ctx.sessionManager object of a started session. */
  session: object;
  provider: string;
  /** null restores Pi authentication; it does not choose the configured named default. */
  account: string | null;
  model?: string;
  signal?: AbortSignal;
  reply(result: AccountActivationResult): void;
};
export function parseAccountsTopologyRequest(data: unknown): AccountsTopologyRequest | undefined {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const request = data as AccountsTopologyRequest;
    return typeof request.reply === "function" ? request : undefined;
  } catch {
    return;
  }
}
export function parseAccountsActivationRequest(data: unknown): AccountsActivationRequest | undefined {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const request = data as AccountsActivationRequest;
    if (!request.session || typeof request.session !== "object" || Array.isArray(request.session)) return;
    if (typeof request.provider !== "string" || !request.provider) return;
    if (request.account !== null && typeof request.account !== "string") return;
    if (request.model !== undefined && (typeof request.model !== "string" || !request.model)) return;
    if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) return;
    return typeof request.reply === "function" ? request : undefined;
  } catch {
    return;
  }
}
export function registerAccountsProtocol(
  pi: ExtensionAPI,
  topology: () => Promise<AccountTopology>,
  activate: (request: AccountsActivationRequest) => Promise<AccountActivationResult>,
): void {
  pi.events.on(ACCOUNTS_TOPOLOGY_CHANNEL, (data) => {
    const request = parseAccountsTopologyRequest(data);
    if (request)
      void topology()
        .then((result) => request.reply(result))
        .catch(() => undefined);
  });
  pi.events.on(ACCOUNTS_ACTIVATION_CHANNEL, (data) => {
    const request = parseAccountsActivationRequest(data);
    if (!request) return;
    // Never forward arbitrary exception text: it may contain provider credentials.
    void activate(request)
      .catch(
        (): AccountActivationResult => ({
          status: "error",
          providerId: request.provider,
          accountName: request.account,
          code: "activation_failed",
        }),
      )
      .then((result) => request.reply(result))
      .catch(() => undefined);
  });
}
