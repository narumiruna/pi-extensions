import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import { loadConfig } from "../settings/config.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { readStateForConfig } from "../state/sync-state-store.js";
import type { SyncLoaders } from "./sync-loaders.js";
import { captureMutationOwner } from "./sync-local.js";
import { syncSessionsSelected } from "./sync-policy.js";
import { hasLocalChanges } from "./sync-state.js";

/** Existing legacy policy; service ownership/consent is established by its caller. */
export async function pushSessionsOnShutdown(
  ctx: EngineContext,
  options: CommandOptions,
  loaders: Pick<SyncLoaders, "operations"> = { operations: () => import("./sync-operations.js") },
) {
  const validate = captureMutationOwner(ctx, options.signal);
  const config = await loadConfig(options.setup);
  validate();
  if (!config.automatic || !syncSessionsSelected(config)) return;
  await withStateDirectoryAccess(() =>
    withLock("auto-session-push", async () => {
      const state = await readStateForConfig(config);
      validate();
      const local = await createSnapshot(config.snapshotIdentity, {
        ...snapshotOptionsForContext(ctx, config),
        signal: options.signal,
      });
      validate();
      if (!hasLocalChanges(local, state, config)) return;
      const operations = await loaders.operations();
      validate();
      await operations.push(
        ctx,
        { ...options, auto: true, yes: true, silent: true, reload: false },
        { config, state, local },
      );
      validate();
    }),
  );
}
