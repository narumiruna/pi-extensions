import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../settings/config.js";
import { confirmMergeReview } from "../ui/merge-review.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import type { AgentEvidence } from "./agent-candidate.js";
import { captureMutationOwner } from "./sync-local.js";

/** Review uses fresh request validation; no private text or provider error enters the summary. */
export async function confirmAgentRefusalRetry(
  ctx: ExtensionContext,
  setup: string | undefined,
  evidence: AgentEvidence,
  validate: () => Promise<void>,
  signal?: AbortSignal,
) {
  const owner = captureMutationOwner(ctx, signal);
  owner();
  const config = await loadConfig(setup);
  owner();
  await validate();
  owner();
  const summary = [
    `Setup: ${safeTerminalText(config.setupName)}`,
    `Storage connection: ${safeTerminalText(config.connectionName)}`,
    `Storage path: ${safeTerminalText(config.storagePath)}`,
    ...(config.backend.type === "s3" ? [`Bucket: ${safeTerminalText(config.backend.destination.bucket)}`] : []),
    ...(config.backend.type === "git" ? [`Branch: ${safeTerminalText(config.backend.destination.branch)}`] : []),
    `Selected model: ${safeTerminalText(ctx.model?.provider ?? "unknown")}/${safeTerminalText(ctx.model?.id ?? "unknown")}`,
    `Conflict paths: ${[...new Set(evidence.units.map((unit) => unit.path))].map(safeTerminalText).join(", ")}`,
    "Send this conflict evidence again despite the cached refusal? This permits one fresh provider request for the reviewed candidate, may incur costs, and can replace selected local and remote content if the result passes validation. Semantic correctness is not guaranteed.",
    "Ordinary Sync now continues to reuse cached results. Automatic request accounting is not cleared or reset. The previous refusal is retained privately. No resources reload automatically. Cancellation cannot recall submitted content, provider charges, or committed writes.",
  ].join("\n\n");
  const confirmed = await confirmMergeReview(
    ctx,
    "Retry refused model result?",
    summary,
    signal,
    () => {
      try {
        owner();
        return true;
      } catch {
        return false;
      }
    },
    "Send one fresh request",
    summary.split("\n"),
  );
  owner();
  if (!confirmed) return false;
  await validate();
  owner();
  return true;
}
