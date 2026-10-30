import type { PiModel, ResolvedUsageAuth } from "./types.js";

type RequestAuth = { apiKey?: string; headers?: Record<string, string | null> };

export class UnsupportedAnthropicUsageAuthError extends Error {
  override readonly name = "UnsupportedAnthropicUsageAuthError";

  constructor() {
    super(
      "Claude extra usage requires matching /login anthropic OAuth; Anthropic API-key usage reporting is not supported.",
    );
  }
}

export function resolveAnthropicUsageAuth(
  auth: RequestAuth,
  providerAuth: RequestAuth,
  model: PiModel,
  candidates: readonly unknown[],
  modelHeaders?: Record<string, string | null>,
): ResolvedUsageAuth {
  // The SDK reads these headers outside Pi's auth resolver. Deliberately reject auth-bearing
  // entries even when an explicit header would override them, rather than infer SDK precedence.
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "authorization" || name === "x-api-key" || name === "host") {
      throw new Error("Claude extra usage does not support authentication or Host overrides in SDK custom headers.");
    }
  }
  const access = auth.apiKey;
  if (!access || access !== providerAuth.apiKey) throw new UnsupportedAnthropicUsageAuthError();
  const matches = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const credential = candidate as Record<string, unknown>;
    if (credential.type !== "oauth" || credential.access !== access) continue;
    if (
      typeof credential.refresh !== "string" ||
      !credential.refresh ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires) ||
      credential.expires <= Date.now()
    ) {
      throw new Error(
        "The matching Anthropic OAuth credential is incomplete or expired; reconnect with /login anthropic.",
      );
    }
    matches.add(credential.refresh);
  }
  if (matches.size > 1) throw new Error("Conflicting OAuth credentials match the active Anthropic runtime account.");
  const refresh = matches.values().next().value;
  if (!refresh) throw new UnsupportedAnthropicUsageAuthError();
  if (effectiveBearer(auth, modelHeaders) !== access || effectiveBearer(providerAuth) !== access) {
    throw new Error("The active Anthropic model authorization does not match its resolved OAuth credential.");
  }
  const authorization = `Bearer ${access}`;
  return {
    apiKey: access,
    headers: { Authorization: authorization },
    fingerprint: "",
    secrets: [access, refresh, authorization],
    model,
  };
}

function effectiveBearer(auth: RequestAuth, modelHeaders?: Record<string, string | null>): string | undefined {
  // Characterized against Pi's anthropic-messages createClient() and the SDK's buildHeaders():
  // OAuth-looking apiKey -> Bearer; other apiKey -> X-Api-Key; defaults are then overridden
  // by model/resolved headers. Object entries replace case-insensitively; null removes.
  // A matching OAuth record is still required above: a token substring alone never authorizes usage.
  try {
    const headers = new Headers();
    if (auth.apiKey) {
      headers.set(
        auth.apiKey.includes("sk-ant-oat") ? "Authorization" : "X-Api-Key",
        auth.apiKey.includes("sk-ant-oat") ? `Bearer ${auth.apiKey}` : auth.apiKey,
      );
    }
    for (const [name, value] of Object.entries({ ...modelHeaders, ...auth.headers })) {
      if (value === undefined) continue;
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    if (headers.has("host") || headers.get("x-api-key")) return undefined;
    return /^Bearer\s+(.+)$/iu.exec(headers.get("authorization") ?? "")?.[1];
  } catch {
    throw new Error("Anthropic runtime authentication headers are invalid.");
  }
}
