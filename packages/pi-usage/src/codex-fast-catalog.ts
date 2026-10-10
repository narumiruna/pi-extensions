import { type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { type CodexFastCapability, isOfficialCodexModel, UNKNOWN_CODEX_FAST_CAPABILITY } from "./codex-fast.js";
import { resolveCodexResetAuth } from "./codex-resets.js";
import { awaitWithDeadline, errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.js";
import type { OAuthCredentialCandidateReader, StoredCredentialReader } from "./oauth-credential-source.js";
import { AUTH_FINGERPRINT_SALT, fetchProviderJson } from "./query.js";
import type { PiModel, ResolvedUsageAuth } from "./types.js";
import { setBoundedMap } from "./usage-helpers.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_ACCOUNT_STATES = 32;
const MAX_DIRECTORY_BODY_BYTES = 8 * 1024 * 1024;
const DIRECTORY_URL = new URL("https://chatgpt.com/backend-api/codex/models");
DIRECTORY_URL.searchParams.set("client_version", VERSION);

type CatalogEntry = {
  models?: ReadonlyMap<string, boolean | undefined>;
  fetchedAt: number;
  fingerprint?: string;
  retryAt?: number;
  issue?: string;
};

type AccountScope = {
  key: string;
  fingerprint: string;
  model: string;
  session: string;
  generation: number;
};

type CatalogOptions = {
  credentialReader?: StoredCredentialReader;
  candidateReader?: OAuthCredentialCandidateReader;
  timeoutMs?: number;
  onChanged?: (ctx: ExtensionContext) => void;
};

/** Account-scoped discovery; request hooks authenticate their cache read without awaiting directory I/O. */
export function createCodexFastCatalog(options: CatalogOptions = {}) {
  const accounts = new Map<string, CatalogEntry>();
  const requests = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const latestRequests = new Map<string, number>();
  const timeoutMs = options.timeoutMs ?? 15_000;
  let requestSequence = 0;
  let identitySequence = 0;
  let generation = 0;
  let active: AccountScope | undefined;
  let issue: string = UNKNOWN_CODEX_FAST_CAPABILITY.reason;

  const current = (scope: AccountScope, ctx: ExtensionContext, signal: AbortSignal) =>
    !signal.aborted &&
    generation === scope.generation &&
    active?.key === scope.key &&
    active.fingerprint === scope.fingerprint &&
    active.model === scope.model &&
    active.session === scope.session &&
    modelIdentity(ctx.model) === scope.model &&
    ctx.sessionManager.getSessionId() === scope.session;

  const capability = (model: PiModel | undefined, key = active?.key): CodexFastCapability => {
    const entry = key ? accounts.get(key) : undefined;
    const supported = model ? entry?.models?.get(model.id) : undefined;
    if (supported !== undefined) return { kind: supported ? "supported" : "unsupported" };
    return {
      kind: "unknown",
      reason:
        entry?.issue ??
        (entry?.models && model
          ? `The Codex model directory has no Fast capability information for ${model.id}.`
          : issue),
    };
  };

  const identify = async (ctx: ExtensionContext, signal: AbortSignal) => {
    const identity = ++identitySequence;
    const owner = generation;
    const model = modelIdentity(ctx.model);
    const session = ctx.sessionManager.getSessionId();
    if (!isOfficialCodexModel(ctx.model)) {
      active = undefined;
      return undefined;
    }
    try {
      // Reuse the existing active-runtime OAuth/account validation, without any reset request.
      const auth = await awaitWithDeadline(
        resolveCodexResetAuth(ctx, undefined, options.credentialReader, options.candidateReader),
        signal,
        timeoutMs,
        "resolving the current Codex model-directory account",
      );
      if (
        signal.aborted ||
        owner !== generation ||
        identity !== identitySequence ||
        modelIdentity(ctx.model) !== model ||
        ctx.sessionManager.getSessionId() !== session
      ) {
        return undefined;
      }
      const accountId = auth.headers["chatgpt-account-id"];
      if (!accountId) throw new Error("The active Codex account ID is unavailable.");
      const scope: AccountScope = {
        key: fingerprintResolvedAuth({ headers: { "chatgpt-account-id": accountId } }, AUTH_FINGERPRINT_SALT),
        fingerprint: auth.fingerprint,
        model,
        session,
        generation: owner,
      };
      const changed = active?.key !== scope.key;
      active = scope;
      issue = "Codex Fast capability information has not been fetched for this account.";
      if (changed) options.onChanged?.(ctx);
      return { auth, scope };
    } catch (error) {
      if (signal.aborted || owner !== generation || identity !== identitySequence) return undefined;
      active = undefined;
      issue = `Codex Fast capability is unknown: ${redactUsageError(errorMessage(error))}`;
      options.onChanged?.(ctx);
      return undefined;
    }
  };

  const load = async (
    ctx: ExtensionContext,
    auth: ResolvedUsageAuth,
    scope: AccountScope,
    signal: AbortSignal,
    force: boolean,
  ): Promise<void> => {
    const entry = accounts.get(scope.key);
    if (
      !force &&
      ((entry?.models && entry.fingerprint === auth.fingerprint && Date.now() - entry.fetchedAt < CACHE_TTL_MS) ||
        (entry?.retryAt && Date.now() < entry.retryAt))
    ) {
      return;
    }
    const before = capability(ctx.model, scope.key);
    const existing = requests.get(auth.fingerprint);
    let promise = existing?.promise;
    if (!promise) {
      const sequence = ++requestSequence;
      latestRequests.set(scope.key, sequence);
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let status: number | undefined;
      promise = (async () => {
        try {
          const payload = await fetchProviderJson(
            DIRECTORY_URL.href,
            auth,
            combined,
            timeoutMs,
            "Codex model directory",
            {
              redirect: "error",
              maxSuccessBodyBytes: MAX_DIRECTORY_BODY_BYTES,
              responseError: (responseStatus) => {
                status = responseStatus;
                return undefined;
              },
            },
          );
          const models = normalizeDirectory(payload);
          if (combined.aborted || scope.generation !== generation || latestRequests.get(scope.key) !== sequence) return;
          setBoundedMap(
            accounts,
            scope.key,
            { models, fetchedAt: Date.now(), fingerprint: auth.fingerprint },
            MAX_ACCOUNT_STATES,
          );
        } catch (error) {
          if (combined.aborted || scope.generation !== generation || latestRequests.get(scope.key) !== sequence) return;
          const previous = accounts.get(scope.key);
          const transient = status === undefined || status >= 500 || status === 429;
          setBoundedMap(
            accounts,
            scope.key,
            {
              ...(transient && previous?.models ? previous : { fetchedAt: 0 }),
              retryAt: Date.now() + FAILURE_BACKOFF_MS,
              issue: `Codex Fast capability is unknown: ${redactUsageError(errorMessage(error), auth.secrets)}`,
            },
            MAX_ACCOUNT_STATES,
          );
        } finally {
          if (requests.get(auth.fingerprint)?.controller === controller) requests.delete(auth.fingerprint);
          if (latestRequests.get(scope.key) === sequence) latestRequests.delete(scope.key);
        }
      })();
      requests.set(auth.fingerprint, { controller, promise });
    }
    await promise;
    const after = capability(ctx.model, scope.key);
    if (current(scope, ctx, signal) && JSON.stringify(before) !== JSON.stringify(after)) options.onChanged?.(ctx);
  };

  return {
    get(model: PiModel | undefined) {
      return capability(model);
    },
    async read(
      ctx: ExtensionContext,
      signal: AbortSignal,
      refresh = false,
      force = false,
    ): Promise<CodexFastCapability | undefined> {
      const resolved = await identify(ctx, signal);
      if (!resolved) return undefined;
      const { auth, scope } = resolved;
      if (refresh) await load(ctx, auth, scope, signal, force || capability(ctx.model, scope.key).kind === "unknown");
      else void load(ctx, auth, scope, signal, false);
      return current(scope, ctx, signal) ? capability(ctx.model, scope.key) : undefined;
    },
    reset(clearCache = false) {
      generation += 1;
      identitySequence += 1;
      active = undefined;
      issue = UNKNOWN_CODEX_FAST_CAPABILITY.reason;
      for (const { controller } of requests.values()) controller.abort();
      requests.clear();
      latestRequests.clear();
      if (clearCache) accounts.clear();
    },
  };
}

function normalizeDirectory(payload: Record<string, unknown>): ReadonlyMap<string, boolean | undefined> {
  if (!Array.isArray(payload.models)) throw new Error("The Codex model directory returned invalid models.");
  const models = new Map<string, boolean | undefined>();
  for (const item of payload.models) {
    if (!isRecord(item) || typeof item.slug !== "string" || !item.slug.trim() || models.has(item.slug)) {
      throw new Error("The Codex model directory returned an invalid or duplicate model ID.");
    }
    const hasTiers = item.service_tiers !== undefined;
    const hasLegacy = item.additional_speed_tiers !== undefined;
    if (
      (hasTiers &&
        (!Array.isArray(item.service_tiers) ||
          item.service_tiers.some((tier) => !isRecord(tier) || typeof tier.id !== "string"))) ||
      (hasLegacy &&
        (!Array.isArray(item.additional_speed_tiers) ||
          item.additional_speed_tiers.some((tier) => typeof tier !== "string")))
    ) {
      throw new Error("The Codex model directory returned invalid service tiers.");
    }
    if (!hasTiers && !hasLegacy) {
      models.set(item.slug, undefined);
      continue;
    }
    const tiers = (item.service_tiers ?? []) as Array<{ id: string }>;
    const legacy = (item.additional_speed_tiers ?? []) as string[];
    models.set(item.slug, tiers.some((tier) => tier.id === "priority") || legacy.includes("fast"));
  }
  return models;
}

function modelIdentity(model: PiModel | undefined): string {
  return model ? `${model.provider}/${model.id}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
