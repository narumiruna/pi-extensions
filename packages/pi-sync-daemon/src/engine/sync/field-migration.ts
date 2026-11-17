import type { EngineContext as ExtensionContext } from "../host.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { sameLocalFields } from "./local-fields.js";
import { captureMutationOwner } from "./sync-local.js";

export async function confirmFieldMigration(
  ctx: ExtensionContext,
  config: AnySyncConfig,
  state: SyncState,
  remote: Snapshot | undefined,
  force: boolean,
  signal?: AbortSignal,
) {
  if (remote?.localFields !== undefined && config.localFields === undefined)
    throw new Error(
      "Portable snapshots require settings version 4 and explicit localFields rules on this machine; older policy must not replace local-only values.",
    );
  const changed =
    (Boolean(state.lastAppliedSnapshot) && !sameLocalFields(state.localFields, config.localFields)) ||
    (remote !== undefined && !sameLocalFields(remote.localFields, config.localFields));
  if (!changed) return true;
  if (!force)
    throw new Error(
      "Local-field policy changed; review an explicit push --force or pull --force migration. Old remote history is not erased.",
    );
  const validate = captureMutationOwner(ctx, signal);
  if (!ctx.hasUI) throw new Error("Local-field migration requires observable TUI/RPC confirmation.");
  validate();
  const confirmed = await ctx.ui.confirm(
    "Migrate portable settings policy?",
    `New machine-local fields: ${(config.localFields ?? []).map(safeTerminalText).join(", ") || "none"}. Additions remove fields from future snapshots, not old history. Removals make local-only values portable again and a pull may replace them. The selected direction is authoritative; inspect /sync diff first. This confirmation is required even with --yes.`,
    { signal },
  );
  validate();
  return confirmed;
}
