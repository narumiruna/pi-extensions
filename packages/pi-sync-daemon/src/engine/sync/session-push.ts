import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { readStateForConfig } from "../state/sync-state-store.js";
import type { SyncLoaders } from "./sync-loaders.js";
import { captureMutationOwner } from "./sync-local.js";
import { syncSessionsSelected } from "./sync-policy.js";
import { hasLocalChanges, syncPolicyChanged } from "./sync-state.js";

/** Existing legacy policy; service ownership/consent is established by its caller. */
export async function pushSessionsOnShutdown(
  ctx: EngineContext,
  options: CommandOptions,
  loaders: Pick<SyncLoaders, "operations"> = { operations: () => import("./sync-operations.js") },
) {
  const validate = captureMutationOwner(ctx, options.signal);
  const config = await loadConfigForCheck(undefined, options.signal);
  validate();
  options.background?.validate(config);
  if (options.setup !== undefined && options.setup !== config.setupName)
    throw new Error("An automatic session push requires the current active sync setup.");
  const fingerprint = syncCheckConfigFingerprint(config);
  const refresh = async () => {
    validate();
    options.background?.validate();
    const latest = await loadConfigForCheck(undefined, options.signal);
    validate();
    options.background?.validate(latest);
    if (fingerprint !== syncCheckConfigFingerprint(latest))
      throw new Error("Settings changed before automatic session push.");
  };
  if (!config.automatic || !syncSessionsSelected(config)) return;
  await withStateDirectoryAccess(() =>
    withLock("auto-session-push", async () => {
      await refresh();
      const state = await readStateForConfig(config);
      await refresh();
      if ((config.scope || state.scope) && (!state.lastAppliedSnapshot || syncPolicyChanged(state, config))) return;
      const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
      await refresh();
      const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
      await refresh();
      if (!hasLocalChanges(local, state, config)) return;
      const operations = await loaders.operations();
      await refresh();
      await operations.push(
        ctx,
        { ...options, auto: true, yes: true, silent: true, reload: false },
        { config, state, local },
      );
      validate();
    }),
  );
}
