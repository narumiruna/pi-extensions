import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUsageAuthGuard, type UsageAuthLifecycle } from "./auth-resolution-guard.js";
import { fingerprintResolvedAuth } from "./core.js";
import { fallbackOAuthCredentialCandidates, type OAuthCredentialCandidateReader } from "./oauth-credential-source.js";
import { openAIAuthAccessToken } from "./providers/openai-chatgpt.js";
import { adapterForProvider, resolveUsageAuth } from "./query.js";
import type { ResolvedUsageAuth } from "./types.js";

// A native app registration is routing metadata, not cryptographic same-account proof.
// Keep this read-only boundary separate from legacy Codex querying and reset mutation policy.
export async function resolveOpenAICompanionAuth(
  ctx: ExtensionContext,
  native: ResolvedUsageAuth,
  salt: Uint8Array,
  credentialReader: (providerId: string) => unknown,
  candidateReader?: OAuthCredentialCandidateReader,
  lifecycle: UsageAuthLifecycle = {},
): Promise<ResolvedUsageAuth> {
  const guard = createUsageAuthGuard(lifecycle);
  guard.check();
  const unavailable = () => ({
    ...native,
    fingerprint: fingerprintResolvedAuth(
      { apiKey: JSON.stringify([native.fingerprint, native.openaiClientId, null]) },
      salt,
    ),
  });
  if (
    candidateReader?.waitUntilReady &&
    !(await guard.wait(() => candidateReader.waitUntilReady?.(ctx, "openai-codex")))
  ) {
    throw new Error("Companion Codex OAuth credential readiness failed closed.");
  }
  const adapter = adapterForProvider("openai-codex");
  if (!adapter) throw new Error("Companion Codex usage support is unavailable.");
  const companion = await guard.wait(() =>
    resolveUsageAuth(ctx, adapter, salt, credentialReader, undefined, undefined, lifecycle),
  );
  if (!companion) return unavailable();
  if (companion.source !== "OAuth")
    throw new Error("Companion usage requires /login openai-codex OAuth, not an API key.");
  // Legacy querying is more permissive. Enforce explicit Authorization removals and duplicates
  // against preserved fresh provider auth before using its normalized request headers.
  const access = openAIAuthAccessToken(companion.auth);
  if (ctx.model?.provider === "openai-codex") {
    const model = ctx.model;
    const selected = await guard.wait(() => ctx.modelRegistry.getApiKeyAndHeaders(model));
    if (
      !selected.ok ||
      (selected.baseUrl && new URL(selected.baseUrl).origin !== "https://chatgpt.com") ||
      openAIAuthAccessToken(selected) !== access
    ) {
      throw new Error("Selected Codex model authorization does not match the companion OAuth credential.");
    }
  }
  if (!access || access !== openAIAuthAccessToken(companion)) {
    throw new Error("Companion Codex runtime authorization did not match its OAuth credential.");
  }
  const accountId = codexAccountId(access);
  if (!accountId) throw new Error("Companion Codex token did not contain a valid account ID.");
  const offered = await guard.wait(() =>
    candidateReader
      ? candidateReader(ctx, "openai-codex")
      : fallbackOAuthCredentialCandidates("openai-codex", credentialReader),
  );
  if (!offered.ok) throw new Error("Companion Codex OAuth credential discovery failed closed.");
  const matches = new Set<string>();
  for (const candidate of offered.candidates) {
    const credential = object(candidate);
    if (credential?.type !== "oauth" || credential.access !== access) continue;
    if (
      credential.accountId !== accountId ||
      typeof credential.refresh !== "string" ||
      !credential.refresh ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires)
    ) {
      throw new Error("The matching companion Codex OAuth credential was incomplete or had a different account ID.");
    }
    matches.add(credential.refresh);
  }
  if (matches.size !== 1) throw new Error("Companion Codex OAuth must uniquely match the fresh runtime credential.");
  const headers = { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId };
  return {
    ...native,
    openaiCompanion: { headers },
    fingerprint: fingerprintResolvedAuth(
      { apiKey: JSON.stringify([native.fingerprint, native.openaiClientId, companion.fingerprint, headers]) },
      salt,
    ),
    secrets: [
      ...new Set([...native.secrets, ...companion.secrets, ...matches, access, accountId, headers.Authorization]),
    ],
  };
}

function codexAccountId(access: string): string | undefined {
  try {
    const parts = access.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    const account = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof account === "string" && account.length > 0 && account.length <= 512 && /^[\x21-\x7e]+$/u.test(account)
      ? account
      : undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
