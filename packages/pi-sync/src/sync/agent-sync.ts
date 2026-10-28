import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOptions } from "../commands/command-types.js";
import { withLock } from "../state/lock.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { AGENT_MAX_ATTEMPTS } from "./agent-policy.js";
import { type AgentAcceptance, AgentResolutionRequired } from "./agent-request.js";
import { ContinuousError } from "./continuous-errors.js";

/** All callers retain their existing state-directory access guard. Off stays lazy. */
export async function withAgentSyncLock<T>(
  ctx: ExtensionContext,
  options: CommandOptions,
  run: (options: CommandOptions) => Promise<T>,
): Promise<T | "cancelled"> {
  let request: AgentResolutionRequired;
  const background = options.background;
  const retry = Boolean(options.agentRetryRefusal);
  if (retry && (options.auto || background || !ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")))
    throw new Error("A refused-model retry requires a foreground TUI or RPC manager review.");
  try {
    return await withLock("sync", () => run(options));
  } catch (error) {
    if (!(error instanceof AgentResolutionRequired)) throw error;
    request = error;
  }
  const { withAgentClaim, readAgentCandidate, saveAgentCandidate, replaceRefusedAgentCandidate } = await import(
    "./agent-store.js"
  );
  const { parseAgentCandidate } = await import("./agent-candidate.js");
  const { runAgentResolver } = await import("./agent-runner.js");
  return withAgentClaim(async (assertOwner) => {
    const clearStatus = () => setSyncStatus(ctx, undefined);
    const onAbort = () => {
      try {
        clearStatus();
      } catch {
        /* UI can already be disposed. */
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      options.signal?.throwIfAborted();
      for (let attempt = 0; attempt < AGENT_MAX_ATTEMPTS; attempt++) {
        let expectedRefusal: ReturnType<typeof parseAgentCandidate> | undefined;
        const validate = (signal = options.signal) =>
          withLock("agent-validate", async () => {
            signal?.throwIfAborted();
            await assertOwner();
            signal?.throwIfAborted();
            if (
              expectedRefusal &&
              JSON.stringify(await readAgentCandidate(request.key)) !== JSON.stringify(expectedRefusal)
            )
              throw new Error("Cached refusal changed during review; reopen the manager.");
            signal?.throwIfAborted();
            await request.validate(signal);
            signal?.throwIfAborted();
          });
        await validate();
        setSyncStatus(ctx, "sync resolving");
        const cached = await withLock("agent-cache-read", async () => {
          await assertOwner();
          options.signal?.throwIfAborted();
          return readAgentCandidate(request.key);
        });
        options.signal?.throwIfAborted();
        if (retry) {
          if (cached === undefined)
            throw new Error("No eligible cached refusal for the current evidence. Use Sync now first.");
          expectedRefusal = parseAgentCandidate(JSON.stringify(cached), request.evidence);
          if (!expectedRefusal.results.some((row) => "refuse" in row))
            throw new Error("The current cached result is not a refusal. Use Sync now.");
          const { confirmAgentRefusalRetry } = await import("./agent-refusal-retry.js");
          options.signal?.throwIfAborted();
          if (!(await confirmAgentRefusalRetry(ctx, options.setup, request.evidence, validate, options.signal)))
            return "cancelled" as const;
        }
        const raw =
          cached === undefined || retry
            ? await runAgentResolver(
                ctx,
                request.evidence,
                validate,
                options.signal,
                background ? (signal) => background.reserve(request.key, signal) : undefined,
              )
            : JSON.stringify(cached);
        let candidate: ReturnType<typeof parseAgentCandidate>;
        try {
          candidate = parseAgentCandidate(raw, request.evidence);
        } catch {
          throw new ContinuousError("model", "Agent mode paused: invalid resolver output; evidence retained.");
        }
        if (retry && candidate.results.some((row) => "refuse" in row))
          throw new ContinuousError("model", "The model refused again. The previous refusal was retained.");
        await validate();
        const previous = expectedRefusal;
        if (!previous)
          await withLock("agent-cache-save", async () => {
            await assertOwner();
            options.signal?.throwIfAborted();
            await saveAgentCandidate(request.key, candidate);
          });
        let retryCacheCommitted = false;
        const acceptance: AgentAcceptance = {
          key: request.key,
          candidate,
          ...(previous
            ? {
                commitCandidate: async () => {
                  if (retryCacheCommitted) return;
                  await replaceRefusedAgentCandidate(request.key, previous, candidate, async () => {
                    options.signal?.throwIfAborted();
                    await assertOwner();
                    await request.validate(options.signal);
                    options.signal?.throwIfAborted();
                  });
                  retryCacheCommitted = true;
                },
              }
            : {}),
        };
        try {
          return await withLock("sync", async () => {
            await assertOwner();
            options.signal?.throwIfAborted();
            return run({ ...options, agentAcceptance: acceptance });
          });
        } catch (error) {
          if (!(error instanceof AgentResolutionRequired)) throw error;
          if (retry) throw new ContinuousError("stale", "Reviewed refusal evidence changed; reopen the manager.");
          request = error;
        }
      }
      throw new ContinuousError("stale", "Agent mode paused: content changed repeatedly; retry later.");
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!options.signal?.aborted) clearStatus();
    }
  });
}
