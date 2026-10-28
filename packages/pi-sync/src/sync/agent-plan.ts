import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import { syncConfigReviewIdentity } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import { readMergeAncestors } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { applyAgentCandidate, buildAgentEvidence, digest } from "./agent-candidate.js";
import { AgentResolutionRequired } from "./agent-request.js";
import { ContinuousError } from "./continuous-errors.js";
import type { FileMergePlan } from "./file-merge-planner.js";
import { fileHashMap, sameHashes } from "./sync-state.js";

export async function resolveAgentPlan(
  ctx: ExtensionContext,
  options: CommandOptions,
  config: AnySyncConfig,
  backend: SyncBackend,
  state: SyncState,
  local: Snapshot,
  localRaw: Snapshot,
  remote: Snapshot,
  head: RemoteHead,
  plan: FileMergePlan,
  snapshotOptions: SnapshotOptions,
  validate: () => Promise<void>,
): Promise<FileMergePlan> {
  if (plan.kind !== "planned" || !plan.conflicts.length) {
    if (options.agentRetryRefusal)
      throw new ContinuousError("unsafe", "No eligible cached refusal for the current evidence. Use Sync now.");
    return plan;
  }
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
    throw new Error("Agent mode paused: TUI/RPC is required.");
  const ancestors = (await readMergeAncestors(config, state)) ?? [];
  await validate();
  let evidence: ReturnType<typeof buildAgentEvidence>;
  try {
    evidence = buildAgentEvidence(plan, local, remote, ancestors);
  } catch {
    throw new ContinuousError("unsafe", "Agent mode paused: unsafe or unsupported conflict evidence.");
  }
  if (!config.partialSync && evidence.unsupported.length)
    throw new ContinuousError("unsafe", "Agent mode paused: unsupported conflicts prevent an all-or-nothing transfer.");
  if (!evidence.files.length) {
    if (options.agentRetryRefusal)
      throw new ContinuousError("unsafe", "No eligible cached refusal for the current evidence. Use Sync now.");
    if (config.partialSync) return plan;
    throw new ContinuousError(
      "unsafe",
      "Agent mode paused: unsupported conflict or missing verified ancestor; evidence is unchanged.",
    );
  }
  if (!evidence.units.length) {
    if (options.agentRetryRefusal)
      throw new ContinuousError("unsafe", "No eligible cached refusal for the current evidence. Use Sync now.");
    return applyAgentCandidate(plan, evidence, { version: 1, results: [] });
  }
  if (!ctx.model) throw new ContinuousError("model", "Agent mode paused: select an available model first.");
  const model = digest(ctx.model);
  const key = digest([
    1,
    backend.identity,
    syncConfigReviewIdentity(config),
    syncStateFingerprint(state),
    head.revision,
    fileHashMap(localRaw),
    evidence,
    model,
  ]);
  if (options.agentAcceptance?.key === key) {
    try {
      return applyAgentCandidate(plan, evidence, options.agentAcceptance.candidate);
    } catch {
      throw new ContinuousError("unsafe", "Agent mode paused: candidate refused or unsupported conflict remains.");
    }
  }
  const validateEvidence = async (signal = options.signal) => {
    const check = async () => {
      signal?.throwIfAborted();
      await validate();
      signal?.throwIfAborted();
    };
    await check();
    if (digest(ctx.model) !== model) throw new Error("Agent mode paused: selected model changed.");
    const current = await createSnapshot(config.snapshotIdentity, { ...snapshotOptions, signal });
    await check();
    const currentState = await readStateForConfig(config);
    await check();
    const currentHead = await backend.readHead(signal);
    await check();
    if (
      !sameHashes(fileHashMap(current), fileHashMap(localRaw)) ||
      syncStateFingerprint(currentState) !== syncStateFingerprint(state) ||
      !currentHead ||
      !backend.sameRevision(head.revision, currentHead.revision)
    )
      throw new ContinuousError("stale", "Agent mode paused: conflict evidence changed; retry a fresh sync.");
  };
  throw new AgentResolutionRequired(key, evidence, validateEvidence);
}
