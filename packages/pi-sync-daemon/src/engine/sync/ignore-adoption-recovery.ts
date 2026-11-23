import type { EngineContext } from "../host.js";
import { loadAdoptionJournal, verifyAdoptionBackup } from "../ignore/adoption-journal.js";
import { compileIgnoreRules, ignorePolicyFingerprint, ignoreSourceDigest } from "../ignore/ignore-source.js";
import { loadConfigForCheck } from "../settings/config.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { recoverPendingSnapshotTransactions } from "../snapshot/snapshot-transaction.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import { withLock } from "../state/lock.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { adoptionSettingsFingerprint } from "./ignore-adoption.js";

export async function recoverAdoptionFilesOnStartup(ctx: EngineContext, signal: AbortSignal, validate: () => void) {
  await withLock(
    "recovery",
    async () => {
      validate();
      if (!(await pendingTransactionEntries()).length) return;
      const journal = await loadAdoptionJournal();
      if (!journal) throw new Error("Adoption recovery evidence changed; restart Pi Sync before editing files.");
      const config = await loadConfigForCheck(journal.setupName, signal);
      const policy = config.ignorePolicy;
      const stale = () => new Error("Pending adoption and file transaction no longer match. Preserve both journals.");
      if (
        !policy ||
        adoptionSettingsFingerprint(config) !== journal.setupFingerprint ||
        policy.filename !== journal.filename ||
        config.ignoreSourceIdentity !== journal.sourceIdentity ||
        policy.fingerprint !== ignorePolicyFingerprint(journal.beforeRules, policy.sessions) ||
        syncStateFingerprint(await readStateForConfig(config)) !== journal.stateFingerprint
      )
        throw stale();
      const options = await resolvedSnapshotOptionsForContext(ctx, config, signal);
      if (options.sessionDir !== journal.sessionDir) throw stale();
      await verifyAdoptionBackup(journal, signal);
      validate();
      const current = ctx.sessionManager.getSessionFile?.();
      await recoverPendingSnapshotTransactions({
        ...options,
        ignorePolicy: {
          ...policy,
          fingerprint: ignorePolicyFingerprint(journal.afterRules, policy.sessions),
          sourceDigest: ignoreSourceDigest(journal.filename, true, Buffer.from(journal.afterRules)),
          matches: compileIgnoreRules(journal.afterRules),
        },
        validateMutation: validate,
        protectedTargets: [...(ctx.protectedSessionFiles ?? []), ...(current ? [current] : [])],
      });
      validate();
      if ((await pendingTransactionEntries()).length) throw stale();
      validate();
    },
    { reclaimStale: true },
  );
}
