import { createHash } from "node:crypto";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { readMergeAncestor } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import type { FileMergePlan } from "./file-merge-planner.js";
import { mergeAcceptedSettingsPackages, mergeSettingsJson } from "./settings-merge.js";

export async function resolveSettingsConflicts(
  config: AnySyncConfig,
  state: SyncState,
  local: Snapshot,
  remote: Snapshot,
  plan: FileMergePlan,
): Promise<{ plan: FileMergePlan; fields: string[] }> {
  if (plan.kind !== "planned") return { plan, fields: [] };
  const fields: string[] = [];
  const decisions = [...plan.decisions];
  for (let index = 0; index < decisions.length; index++) {
    const decision = decisions[index];
    if (decision?.path !== "settings.json") continue;
    if (decision.kind === "conflict" ? decision.reason !== "both-changed" : !config.agentMode) continue;
    const left = local.files.find((file) => file.path === decision.path);
    const right = remote.files.find((file) => file.path === decision.path);
    if (!left || !right) continue; // File deletion/addition is not a JSON field merge.
    const ancestor = await readMergeAncestor(config, state, decision.path);
    if (!ancestor) continue;
    const leftBytes = Buffer.from(left.contentBase64, "base64");
    const rightBytes = Buffer.from(right.contentBase64, "base64");
    let content: Buffer;
    if (decision.kind === "accepted") {
      if (!decision.file) continue;
      const patched = mergeAcceptedSettingsPackages(
        ancestor,
        leftBytes,
        rightBytes,
        Buffer.from(decision.file.contentBase64, "base64"),
      );
      if (!patched) continue;
      content = patched;
    } else {
      const merged = mergeSettingsJson(ancestor, leftBytes, rightBytes, undefined, Boolean(config.agentMode));
      if (merged.kind === "review") {
        fields.push(...merged.fields);
        continue;
      }
      content = merged.content;
    }
    decisions[index] = {
      kind: "accepted",
      path: decision.path,
      source: "merged",
      file: {
        path: decision.path,
        contentBase64: content.toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
  }
  return {
    plan: { kind: "planned", decisions, conflicts: decisions.filter((decision) => decision.kind === "conflict") },
    fields,
  };
}
