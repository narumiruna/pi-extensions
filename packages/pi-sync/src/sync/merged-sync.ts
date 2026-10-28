import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import {
  expectedRemoteHead,
  type RemoteHead,
  type SyncBackend,
  SyncBackendConflictError,
} from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import {
  effectiveSessionRoot,
  requireStableMergeSessionRoot,
  snapshotOptionsForContext,
} from "../snapshot/session-paths.js";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
  regenerateSnapshotIdentity,
  scanSnapshot,
} from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import {
  hasCurrentMergeBaseline,
  pruneMergeBaselines,
  readMergeAncestors,
  stageMergeBaseline,
} from "../state/merge-baseline-store.js";
import {
  readStateForConfig,
  statePathForConfig,
  syncStateFingerprint,
  writeStateForConfig,
} from "../state/sync-state-store.js";
import { confirmMergeReview } from "../ui/merge-review.js";
import { mergedSyncSummary } from "../ui/merged-sync-summary.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { startupTransferEnabled } from "./agent-policy.js";
import { releaseConflictArtifacts } from "./conflict-artifact-ownership.js";
import {
  type CreatedConflictArtifact,
  conflictGroups,
  readConflictArtifact,
  saveConflictArtifact,
} from "./conflict-artifacts.js";
import { type ConflictResolution, resolveReviewedGroup } from "./conflict-resolution.js";
import { pruneCompletedConflicts } from "./conflict-retention.js";
import { resolveContentConflicts } from "./content-conflicts.js";
import { ContinuousError } from "./continuous-errors.js";
import { planFileMerge } from "./file-merge-planner.js";
import { overlayLocalFields, portableSnapshot, sameLocalFields } from "./local-fields.js";
import { applyMergedSnapshot, preflightMergedTargets } from "./merge-apply.js";
import {
  clearMergeJournal,
  type MergeJournal,
  mergeJournalIdentity,
  readMergeJournal,
  writeMergeJournal,
} from "./merge-journal.js";
import { mergeTransferError } from "./merge-transfer-error.js";
import { acceptedMergeFiles, type PartialProgress, progressState } from "./partial-progress.js";
import {
  formatRemoteSelectionStatus,
  readSnapshotForHead,
  requireCompatibleRemoteSelection,
} from "./remote-snapshot.js";
import { resolveSettingsConflicts } from "./settings-conflicts.js";
import { createStartupTimings, type StartupTimings } from "./startup-timings.js";
import { createSyncDecision } from "./sync-decision.js";
import { backupLocal, captureMutationOwner, protectedSessionPaths } from "./sync-local.js";
import { inspectRemoteSelection } from "./sync-policy.js";
import { fileHashMap, hasLocalChanges, hasRemoteChanges, sameHashes, syncPolicyChanged } from "./sync-state.js";
import { TEXT_MERGE_WORK_LIMIT } from "./text-merge.js";

const MAX_ATTEMPTS = 3;

/** Established-baseline sync only. First-source selection remains in the existing command flow. */
export async function mergeSync(
  ctx: ExtensionContext | ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  resolution?: ConflictResolution,
) {
  const timings = options.startupTimings ?? createStartupTimings();
  const sessionOwner = captureMutationOwner(ctx, options.signal);
  const validateOwner = (config?: AnySyncConfig) => {
    sessionOwner();
    options.background?.validate(config);
  };
  const isCurrent = () => {
    try {
      validateOwner();
      return true;
    } catch {
      return false;
    }
  };
  const validateRetryAuthorization = (config: AnySyncConfig) => {
    if (
      options.agentRetryRefusal &&
      (!config.agentMode || options.auto || options.background || !ctx.hasUI || !["tui", "rpc"].includes(ctx.mode))
    )
      throw new Error("Refused-candidate retry requires foreground Agent mode in TUI or RPC.");
  };
  const config = await loadConfig(options.setup);
  validateOwner(config);
  validateRetryAuthorization(config);
  const configToken = syncCheckConfigFingerprint(config);
  const modelToken = JSON.stringify(ctx.model);
  const sessionRoot = config.include.includes("sessions") ? await effectiveSessionRoot(ctx) : undefined;
  validateOwner();
  const snapshotOptions = {
    ...snapshotOptionsForContext(ctx, config),
    sessionDir: sessionRoot,
    signal: options.signal,
  };
  const validate = () =>
    timings.measure("transfer authorization", async () => {
      validateOwner();
      const latest = await loadConfig(options.setup);
      validateOwner(latest);
      validateRetryAuthorization(latest);
      if (configToken !== syncCheckConfigFingerprint(latest))
        throw new Error("Sync setup or settings changed during transfer; reopen sync.");
      if (sessionRoot !== undefined) {
        const currentRoot = await effectiveSessionRoot(ctx);
        validateOwner();
        if (currentRoot !== sessionRoot)
          throw new Error("Session storage root changed during transfer; evidence retained for review.");
      }
      if (config.agentMode && JSON.stringify(ctx.model) !== modelToken)
        throw new Error("Agent mode paused: selected model changed during transfer.");
      if (options.auto && (!startupTransferEnabled(latest) || !ctx.isIdle()))
        throw new Error("Automatic transfer is no longer authorized at this idle boundary.");
    });
  await validate();
  const backend = await timings.measure("transfer backend initialization", () => factory(config));
  await validate();
  const pending = await timings.measure("transfer journal read", () => readMergeJournal(config));
  await validate();
  if (pending && options.agentRetryRefusal)
    throw new Error("A pending merge journal requires ordinary Sync now before retrying a refused candidate.");
  if (pending) {
    const recovered = await timings.measure("transfer journal recovery", () =>
      completeJournal(
        ctx,
        config,
        backend,
        pending,
        validate,
        timings,
        options.signal,
        options.auto,
        options.background?.validate,
      ),
    );
    if (!recovered) {
      if ((options.auto || !options.silent) && !options.signal?.aborted)
        ctx.ui.notify(
          "Interrupted candidate is not active; local content and baseline were unchanged. Evidence was reconciled without retrying publication. Run sync again for a fresh plan.",
          "warning",
        );
      return "cancelled" as const;
    }
    if ((options.auto || !options.silent) && !options.signal?.aborted)
      ctx.ui.notify("Recovered the committed merged transfer. Run sync again to inspect newer changes.", "info");
    return "applied" as const;
  }
  // Recovery above never publishes. This gate applies only to new autonomous transfers.
  if ((options.auto || config.agentMode) && backend.capability === "read-check-write-verify") {
    throw new Error(
      "Automatic transfer requires conditional publication or a lease; this backend supports only read/check/write/verify. Disable Agent mode and use manual sync.",
    );
  }
  const textBudget = { remaining: TEXT_MERGE_WORK_LIMIT };
  const createdArtifacts: CreatedConflictArtifact[] = [];
  const ownedStatePath = statePathForConfig(config);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await validate();
      const state = await timings.measure("transfer state read", () => readStateForConfig(config));
      if (state.unresolved?.length && !config.partialSync)
        throw new Error(
          "Partial progress remains unresolved; re-enable partial sync or review an explicit force direction.",
        );
      const localRaw = await timings.measure("transfer local snapshot", () =>
        createSnapshot(config.snapshotIdentity, snapshotOptions),
      );
      const local = portableSnapshot(localRaw, config.localFields);
      if (!sameLocalFields(state.localFields, config.localFields))
        throw new Error("Local-field rules changed; review and confirm a directional migration first.");
      const head = await timings.measure("transfer remote head", () => backend.readHead(options.signal));
      await validate();
      // This is a read-only shortcut, never authority to apply or publish. Pending
      // journals were handled above. Legacy/partial baselines retain the full path.
      if (
        options.auto &&
        !resolution &&
        !config.partialSync &&
        head &&
        state.lastAppliedSnapshot &&
        state.lastRemoteRevision &&
        !state.unresolved?.length &&
        head.snapshotId === state.lastAppliedSnapshot &&
        backend.sameRevision(head.revision, state.lastRemoteRevision) &&
        inspectRemoteSelection(config.include, { selection: head.selection, files: [] }).kind === "same" &&
        matchesAcceptedState(state, config, head, local)
      ) {
        const unchanged = await timings.measure("transfer unchanged verification", async () => {
          if (!(await hasCurrentMergeBaseline(config, local, state))) return false;
          await validate();
          const currentLocal = await timings.measure("transfer local snapshot", () =>
            createSnapshot(config.snapshotIdentity, snapshotOptions),
          );
          await validate();
          const currentState = await timings.measure("transfer state read", () => readStateForConfig(config));
          await validate();
          return (
            sameHashes(fileHashMap(currentLocal), fileHashMap(localRaw)) &&
            syncStateFingerprint(currentState) === syncStateFingerprint(state)
          );
        });
        await validate();
        if (unchanged) {
          timings.markUnchanged();
          return "applied" as const;
        }
      }
      const rawRemote = head
        ? await timings.measure("transfer snapshot download", () => readSnapshotForHead(backend, head, options.signal))
        : undefined;
      await validate();
      if (rawRemote) {
        const files = [...local.files, ...rawRemote.files];
        if (
          files.length > 16_384 ||
          files.reduce((bytes, file) => bytes + file.contentBase64.length * 0.75, 0) > 64 * 1024 * 1024
        ) {
          throw new Error(
            "Merged transfer exceeds the 64 MiB / 16,384 input-file bound; review an explicit push or pull instead.",
          );
        }
      }
      const remote = rawRemote
        ? portableSnapshot(filterSnapshotForConfigPolicy(rawRemote, config), rawRemote.localFields)
        : undefined;
      if (rawRemote) {
        requireCompatibleRemoteSelection(config, rawRemote);
        const validation = await timings.measure("transfer merge planning", () =>
          planFileMerge({
            baseline: state.lastFileHashes,
            local: local.files,
            remote: rawRemote.files,
            selectionCompatible: true,
          }),
        );
        await validate();
        const managedPaths = new Set([
          ...Object.keys(state.lastFileHashes),
          ...[...local.files, ...(remote?.files ?? [])].map((file) => file.path),
        ]);
        if (
          validation.kind === "planned" &&
          validation.conflicts.some(
            (item) => item.reason === "path-collision" && (!config.partialSync || !managedPaths.has(item.path)),
          )
        )
          throw new Error("Remote snapshot contains path collisions; review a directional recovery before merging.");
      }
      const review = (
        message: string,
        kind: "both-changed" | "remote-empty" | "remote-or-policy-changed" = "both-changed",
      ) =>
        createSyncDecision({
          kind,
          config,
          state,
          local,
          remote,
          localChanged: hasLocalChanges(local, state, config),
          remoteChanged: remote ? hasRemoteChanges(remote, state, config) : Boolean(state.lastAppliedSnapshot),
          directMessage: message,
        });
      if (!state.lastAppliedSnapshot) throw review("Choose the initial source before enabling automatic transfer.");
      if (syncPolicyChanged(state, config))
        throw review("Included content changed; review the selection before merging.", "remote-or-policy-changed");
      if (!head || !remote || !rawRemote)
        throw review("The established remote is missing; choose an explicit recovery direction.", "remote-empty");
      const selectionState = inspectRemoteSelection(config.include, rawRemote);
      const selectionCompatible = selectionState.kind === "same";
      let plan = await timings.measure("transfer merge planning", () =>
        planFileMerge({
          baseline: state.lastFileHashes,
          local: local.files,
          remote: remote.files,
          selectionCompatible,
          protectedPaths: protectedSessionPaths(ctx, sessionRoot),
        }),
      );
      await validate();
      let resolved = { plan, fields: [] as string[] };
      if (config.mergeSettings || config.agentMode) {
        try {
          resolved = await timings.measure("transfer settings merge", () =>
            resolveSettingsConflicts(config, state, local, remote, plan),
          );
        } catch (error) {
          if (!config.partialSync) throw error;
        }
      }
      await validate();
      plan = await timings.measure("transfer content merge", () =>
        resolveContentConflicts(config, state, local, remote, resolved.plan, protectedSessionPaths(ctx, sessionRoot), {
          textBudget,
          signal: options.signal,
        }),
      );
      await validate();
      if (resolution) {
        plan = await resolveReviewedGroup(
          config,
          backend,
          state,
          local,
          remote,
          head,
          plan,
          resolution,
          protectedSessionPaths(ctx, sessionRoot),
        );
        await validate();
      }
      if (config.agentMode && !resolution) {
        const { resolveAgentPlan } = await import("./agent-plan.js");
        await validate();
        plan = await resolveAgentPlan(
          ctx,
          options,
          config,
          backend,
          state,
          local,
          localRaw,
          remote,
          head,
          plan,
          snapshotOptions,
          validate,
        );
        await validate();
        if (plan.kind !== "planned" || (plan.conflicts.length && !config.partialSync))
          throw new ContinuousError(
            "unsafe",
            "Agent mode paused: unsupported or refused conflict groups remain; no transfer was performed.",
          );
      }
      if (
        plan.kind !== "planned" ||
        (plan.conflicts.length && (!config.partialSync || (options.auto && !config.agentMode)))
      ) {
        const decision = review(
          selectionCompatible
            ? `Conflicting or protected paths require review; no merged transfer was performed. Use /sync diff and an explicit direction.${resolved.fields.length ? ` Settings fields: ${resolved.fields.map(safeTerminalText).join(", ")}` : ""}`
            : "Remote selection metadata is unavailable; review the included content and choose an explicit direction before merging.",
          selectionCompatible ? "both-changed" : "remote-or-policy-changed",
        );
        if (!selectionCompatible)
          decision.decision.review += `\n\n${formatRemoteSelectionStatus(selectionState)}\nAn explicit direction adopts this setup's included-content policy; no automatic merge was performed.`;
        throw decision;
      }
      if (plan.kind !== "planned") throw new Error("Cannot partition an unverified merge plan.");
      const groups = conflictGroups(plan, config);
      const withheld = new Set(groups.flatMap((group) => group.paths));
      // Transfer plans defer artifact writes until approved review and freshness guards pass.
      // A no-transfer manual inspection can persist referenced conflict state directly.
      const persistProgress = async (): Promise<PartialProgress | undefined> => {
        if (!groups.length) return;
        let ancestors: import("../snapshot/snapshot-types.js").SnapshotFile[] = [];
        try {
          ancestors = ((await readMergeAncestors(config, state)) ?? []).filter((file) => withheld.has(file.path));
        } catch {
          /* Retain unknown evidence; absence remains explicit. */
        }
        await validate();
        const previousArtifacts = new Map<
          string,
          {
            artifact: Awaited<ReturnType<typeof readConflictArtifact>>;
            local: ReturnType<typeof fileHashMap>;
            remote: ReturnType<typeof fileHashMap>;
          }
        >();
        for (const token of new Set(state.unresolved?.map((group) => group.artifact) ?? [])) {
          try {
            const artifact = await readConflictArtifact(config, backend.identity, token);
            previousArtifacts.set(token, {
              artifact,
              local: fileHashMap(artifact.local),
              remote: fileHashMap(artifact.remote),
            });
          } catch {
            /* Unknown evidence retained, never reused. */
          }
          await validate();
        }
        const localHashes = fileHashMap(local);
        const remoteHashes = fileHashMap(remote);
        const previousGroups = new Map(state.unresolved?.map((item) => [JSON.stringify(item.paths), item]));
        const pending = groups.map((group) => {
          const previous = previousGroups.get(JSON.stringify(group.paths));
          const original = previous ? previousArtifacts.get(previous.artifact) : undefined;
          if (!original || !previous) return { group };
          return group.paths.every(
            (filePath) =>
              localHashes[filePath] === original.local[filePath] &&
              remoteHashes[filePath] === original.remote[filePath] &&
              state.lastFileHashes[filePath] === original.artifact.state.lastFileHashes[filePath],
          )
            ? { group, artifact: previous.artifact }
            : { group };
        });
        let artifact: string | undefined;
        const newGroups = pending.filter((item) => !item.artifact).map((item) => item.group);
        const newPaths = new Set(newGroups.flatMap((group) => group.paths));
        if (newGroups.length)
          artifact = await saveConflictArtifact(
            config,
            backend.identity,
            {
              state,
              local: { ...local, files: local.files.filter((file) => newPaths.has(file.path)) },
              remote: { ...remote, files: remote.files.filter((file) => newPaths.has(file.path)) },
              ancestors: ancestors.filter((file) => newPaths.has(file.path)),
              groups: newGroups,
              observed: { snapshotId: head.snapshotId, revision: head.revision },
            },
            captureMutationOwner(ctx, options.signal),
            (created) => createdArtifacts.push(created),
          );
        await validate();
        return {
          previous: state,
          groups: pending.map((item) => ({ paths: item.group.paths, artifact: item.artifact ?? artifact ?? "" })),
        };
      };
      let progress: PartialProgress | undefined;
      const accepted = regenerateSnapshotIdentity({
        ...local,
        files: acceptedMergeFiles(plan.decisions, local.files, withheld),
      });
      const after = overlayLocalFields(accepted, localRaw, config.localFields);
      if (config.include.includes("sessions")) requireStableMergeSessionRoot(localRaw, after);
      const publication = regenerateSnapshotIdentity({
        ...accepted,
        version: config.partialSync ? 3 : accepted.version,
        files: [
          ...accepted.files.filter((file) => !withheld.has(file.path)),
          ...remote.files.filter((file) => withheld.has(file.path)),
        ],
      });
      const upload = mergeRemotePreservedFiles(publication, rawRemote, config);
      const publish =
        !sameHashes(fileHashMap(publication), fileHashMap(remote)) ||
        Boolean(config.partialSync && rawRemote.version !== 3);
      const apply = !sameHashes(fileHashMap(localRaw), fileHashMap(after));
      if (!publish && !apply) {
        const beforeEvidence = await timings.measure("transfer remote head", () => backend.readHead(options.signal));
        await validate();
        if (!beforeEvidence || !backend.sameRevision(beforeEvidence.revision, head.revision))
          throw new ContinuousError(
            "stale",
            "Remote changed before baseline acceptance; retry from a fresh observation.",
          );
        progress = await persistProgress();
        await validate();
        const currentLocal = await timings.measure("transfer local snapshot", () =>
          createSnapshot(config.snapshotIdentity, snapshotOptions),
        );
        await validate();
        if (
          !sameHashes(fileHashMap(currentLocal), fileHashMap(localRaw)) ||
          syncStateFingerprint(await timings.measure("transfer state read", () => readStateForConfig(config))) !==
            syncStateFingerprint(state)
        )
          throw new ContinuousError(
            "stale",
            "Local content or baseline changed before baseline acceptance; retry from a fresh observation.",
          );
        await validate();
        const currentHead = await timings.measure("transfer remote head", () => backend.readHead(options.signal));
        await validate();
        if (!currentHead || !backend.sameRevision(currentHead.revision, head.revision))
          throw new ContinuousError(
            "stale",
            "Remote changed before baseline acceptance; retry from a fresh observation.",
          );
        await options.agentAcceptance?.commitCandidate?.();
        await validate();
        await timings.measure("transfer baseline write", () =>
          writeAcceptedState(config, head, accepted, validate, progress),
        );
        await timings.measure("transfer cleanup", () =>
          pruneMergeBaselines(
            config,
            acceptedState(config, head, accepted, progress),
            captureMutationOwner(ctx, options.signal),
          ),
        );
        await validate();
        await timings.measure("transfer cleanup", () =>
          pruneCompletedConflicts(
            config,
            backend.identity,
            acceptedState(config, head, accepted, progress),
            accepted,
            remote,
            captureMutationOwner(ctx, options.signal),
          ),
        );
        await validate();
        if (!options.silent)
          ctx.ui.notify(
            progress
              ? `No independent transfer required; ${groups.length} conflict groups remain withheld. Review /sync conflicts.`
              : "Pi Sync is already up to date.",
            progress ? "warning" : "info",
          );
        return "applied" as const;
      }
      await timings.measure("transfer preflight", () =>
        preflightMergedTargets(localRaw, after, snapshotOptions, ctx.sessionManager.getSessionFile?.()),
      );
      await validate();
      if (!config.skipSecretScan && scanSnapshot(upload).length)
        throw new ContinuousError(
          "unsafe",
          "Refusing to merge possible secrets. Review managed content before syncing.",
        );
      if (!options.yes && !config.agentMode) {
        const summary = mergedSyncSummary({
          setupName: config.setupName,
          destination: backend.destination,
          localBefore: localRaw,
          localAfter: after,
          remoteBefore: rawRemote,
          remoteAfter: upload,
          publish,
          sessions: config.include.includes("sessions"),
          groups,
          decisions: plan.decisions,
          capability: backend.capability,
        });
        if (
          !(await confirmMergeReview(
            ctx,
            summary.title,
            summary.content,
            options.signal,
            isCurrent,
            summary.confirmationLabel,
            summary.lines,
          ))
        )
          return "cancelled" as const;
      }
      await validate();
      const refreshed = await timings.measure("transfer local snapshot", () =>
        createSnapshot(config.snapshotIdentity, snapshotOptions),
      );
      if (!sameHashes(fileHashMap(refreshed), fileHashMap(localRaw)))
        throw new ContinuousError("stale", "Local content changed during review; no merged transfer was performed.");
      if (
        syncStateFingerprint(await timings.measure("transfer state read", () => readStateForConfig(config))) !==
        syncStateFingerprint(state)
      )
        throw new ContinuousError("stale", "Sync baseline changed during review; retry from a fresh observation.");
      await validate();
      const refreshedHead = await timings.measure("transfer remote head", () => backend.readHead(options.signal));
      await validate();
      if (!refreshedHead || !backend.sameRevision(refreshedHead.revision, head.revision))
        throw new ContinuousError("stale", "Remote changed during review; no merged transfer was performed.");
      await options.agentAcceptance?.commitCandidate?.();
      await validate();
      progress = await persistProgress();
      await validate();
      const backup = await timings.measure("transfer backup", () =>
        backupLocal(config.snapshotIdentity, snapshotOptions, options.signal),
      );
      await validate();
      const journal: MergeJournal = {
        version: 1,
        identity: mergeJournalIdentity(config, backend.identity),
        before: localRaw,
        after,
        accepted,
        ...(progress ? { progress } : {}),
        upload: publish ? upload : rawRemote,
        expectedHead: head,
        backup,
        stateIdentity: syncStateFingerprint(state),
        ...(sessionRoot !== undefined ? { sessionRoot } : {}),
        ...(!publish ? { committedHead: head, applyOnly: true } : {}),
      };
      await timings.measure("transfer journal write", () => writeMergeJournal(config, journal));
      // No backend call has begun: a stale candidate can be retired without ambiguous publication.
      const atCommitState = syncStateFingerprint(
        await timings.measure("transfer state read", () => readStateForConfig(config)),
      );
      await validate();
      const atCommit = await timings.measure("transfer local snapshot", () =>
        createSnapshot(config.snapshotIdentity, snapshotOptions),
      );
      await validate();
      if (!sameHashes(fileHashMap(atCommit), fileHashMap(localRaw)) || atCommitState !== journal.stateIdentity) {
        await validate();
        await clearMergeJournal(config);
        throw new ContinuousError(
          "stale",
          "Local content or baseline changed before publication; candidate retired without transfer. Review a fresh sync.",
        );
      }
      // Backup/journal awaits can also change physical identity without changing any bytes.
      try {
        await timings.measure("transfer preflight", () =>
          preflightMergedTargets(atCommit, after, snapshotOptions, ctx.sessionManager.getSessionFile?.()),
        );
        await validate();
      } catch (error) {
        await validate();
        await clearMergeJournal(config);
        throw error;
      }
      try {
        if (publish) {
          const result = await timings.measure("transfer remote publication", () =>
            backend.publishSnapshot(upload, expectedRemoteHead(head), {
              signal: options.signal,
              onCommit: options.onCommit,
            }),
          );
          journal.committedHead = result.head;
          journal.warnings = result.warnings;
          await timings.measure("transfer journal write", () => writeMergeJournal(config, journal));
        } else options.onCommit?.();
      } catch (error) {
        if (
          error instanceof SyncBackendConflictError &&
          error.phase === "before-commit" &&
          !error.candidateMayHaveBeenActive
        ) {
          await clearMergeJournal(config);
          if (attempt + 1 < MAX_ATTEMPTS) continue;
          throw new Error("Remote changed before commit in all three attempts; retry later.", { cause: error });
        }
        // Cancellation before publication is safe only if no backend attempt began.
        // Every uncertain/after-commit outcome retains evidence and is never blindly retried.
        throw mergeTransferError(error, config.backend);
      }
      const completed = await timings.measure("transfer journal recovery", () =>
        completeJournal(
          ctx,
          config,
          backend,
          journal,
          validate,
          timings,
          options.signal,
          options.auto,
          options.background?.validate,
        ),
      );
      if (!completed) {
        if (!options.signal?.aborted && (options.auto || !options.silent))
          ctx.ui.notify(
            "Remote changed before local apply; candidate retired without transfer. Run sync again.",
            "warning",
          );
        return "cancelled" as const;
      }
      if (!options.signal?.aborted && (options.auto || !options.silent))
        ctx.ui.notify(
          [
            `Synced independent changes for “${safeTerminalText(config.setupName)}”. ${apply ? "Local files changed; reload or restart Pi when ready to use changed resources." : "Remote updated."} No automatic reload.`,
            ...(progress
              ? [
                  `Partial progress: ${groups.length} dependency groups remain unresolved; neither side's withheld versions or baseline hashes were replaced. Review /sync conflicts.`,
                ]
              : []),
            ...(journal.warnings ?? []).map(safeTerminalText),
          ].join("\n"),
          progress || journal.warnings?.length ? "warning" : "info",
        );
      return "applied" as const;
    }
  } finally {
    await timings.measure("transfer cleanup", () => releaseConflictArtifacts(config, ownedStatePath, createdArtifacts));
  }
}

async function completeJournal(
  ctx: ExtensionContext | ExtensionCommandContext,
  config: AnySyncConfig,
  backend: SyncBackend,
  journal: MergeJournal,
  validate: () => Promise<void>,
  timings: StartupTimings,
  signal?: AbortSignal,
  auto = false,
  validateBackground?: () => void,
) {
  if (
    journal.identity !== mergeJournalIdentity(config, backend.identity) ||
    !sameLocalFields(journal.upload.localFields, config.localFields)
  )
    throw new Error(
      "Merge journal belongs to a different setup, selection or local-field policy; preserve it for reviewed recovery.",
    );
  await validate();
  const sessionRoot = config.include.includes("sessions") ? await effectiveSessionRoot(ctx) : undefined;
  await validate();
  if (sessionRoot !== undefined && journal.sessionRoot !== sessionRoot) {
    throw new Error(
      "Merge journal session root is missing or differs from this context; preserve evidence and use reviewed directional recovery.",
    );
  }
  const snapshotOptions = { ...snapshotOptionsForContext(ctx, config), sessionDir: sessionRoot, signal };
  const head = await timings.measure("transfer remote head", () => backend.readHead(signal));
  if (
    !journal.committedHead &&
    head &&
    (backend.sameRevision(head.revision, journal.expectedHead.revision) ||
      backend.matchesUncommittedRecoveryHead?.(head, journal.expectedHead))
  ) {
    await validate();
    const local = await timings.measure("transfer local snapshot", () =>
      createSnapshot(config.snapshotIdentity, snapshotOptions),
    );
    if (
      !sameHashes(fileHashMap(local), fileHashMap(journal.before)) ||
      syncStateFingerprint(await timings.measure("transfer state read", () => readStateForConfig(config))) !==
        journal.stateIdentity
    ) {
      throw new Error(
        "Uncertain publication is not active, but local content or baseline changed; keep the journal for reviewed recovery.",
      );
    }
    await clearMergeJournal(config);
    return false;
  }
  await validate();
  // Baseline publication is the durable completion boundary. A later remote revision
  // cannot undo that acceptance; retire only the journal for the recorded commit.
  if (journal.committedHead && (!head || !backend.sameRevision(head.revision, journal.committedHead.revision))) {
    const state = await timings.measure("transfer state read", () => readStateForConfig(config));
    await validate();
    if (
      matchesAcceptedState(state, config, journal.committedHead, journal.accepted ?? journal.after, journal.progress)
    ) {
      await clearMergeJournal(config);
      await validate();
      await pruneMergeBaselines(config, state, captureMutationOwner(ctx, signal));
      await validate();
      return true;
    }
  }
  if (journal.applyOnly && (!head || !backend.sameRevision(head.revision, journal.expectedHead.revision))) {
    const local = await timings.measure("transfer local snapshot", () =>
      createSnapshot(config.snapshotIdentity, snapshotOptions),
    );
    const state = await timings.measure("transfer state read", () => readStateForConfig(config));
    await validate();
    if (
      sameHashes(fileHashMap(local), fileHashMap(journal.before)) &&
      syncStateFingerprint(state) === journal.stateIdentity
    ) {
      await clearMergeJournal(config);
      return false;
    }
    throw new Error("Apply-only remote head advanced after local changes; preserve the journal for reviewed recovery.");
  }
  if (
    !head ||
    head.snapshotId !== journal.upload.id ||
    (journal.committedHead && !backend.sameRevision(head.revision, journal.committedHead.revision))
  ) {
    throw new Error(
      "Publication outcome cannot be reconciled with the current remote head. Journal and backup retained; do not retry publication or restore old bytes blindly.",
    );
  }
  const observed = await timings.measure("transfer snapshot download", () =>
    readSnapshotForHead(backend, head, signal),
  );
  requireCompatibleRemoteSelection(config, observed);
  if (
    !sameHashes(fileHashMap(observed), fileHashMap(journal.upload)) ||
    JSON.stringify(observed.selection) !== JSON.stringify(journal.upload.selection)
  )
    throw new Error("Remote snapshot does not match the recorded merge publication.");
  const state = await timings.measure("transfer state read", () => readStateForConfig(config));
  if (matchesAcceptedState(state, config, head, journal.accepted ?? journal.after, journal.progress)) {
    await validate();
    await clearMergeJournal(config);
    await validate();
    await pruneMergeBaselines(config, state, captureMutationOwner(ctx, signal));
    await validate();
    return true;
  }
  if (syncStateFingerprint(state) !== journal.stateIdentity) {
    throw new Error("Sync baseline changed after the interrupted merge; preserve its journal and review recovery.");
  }
  if (inspectRemoteSelection(config.include, observed).kind !== "same")
    throw new Error(
      "Pending merge has unavailable remote selection metadata; preserve its journal and choose a reviewed explicit direction.",
    );
  if (config.include.includes("sessions")) requireStableMergeSessionRoot(journal.before, journal.after);
  await validate();
  const validateOwner = captureMutationOwner(ctx, signal);
  const validateMutation = () => {
    validateOwner();
    validateBackground?.();
    if (auto && !ctx.isIdle()) throw new Error("Automatic file apply is no longer idle; evidence retained.");
  };
  await timings.measure("transfer local apply", () =>
    applyMergedSnapshot(
      journal.before,
      journal.after,
      protectedSessionPaths(ctx, sessionRoot),
      { ...snapshotOptions, validateMutation },
      validate,
      ctx.sessionManager.getSessionFile?.(),
    ),
  );
  await validate();
  const headAtAcceptance = await timings.measure("transfer remote head", () => backend.readHead(signal));
  await validate();
  if (!headAtAcceptance || !backend.sameRevision(headAtAcceptance.revision, head.revision))
    throw new Error("Remote changed during merged apply; journal and backup retained for review.");
  await timings.measure("transfer baseline write", () =>
    writeAcceptedState(config, head, journal.accepted ?? journal.after, validate, journal.progress),
  );
  await validate();
  await clearMergeJournal(config);
  await validate();
  await timings.measure("transfer cleanup", () =>
    pruneMergeBaselines(
      config,
      acceptedState(config, head, journal.accepted ?? journal.after, journal.progress),
      captureMutationOwner(ctx, signal),
    ),
  );
  await validate();
  await timings.measure("transfer cleanup", () =>
    pruneCompletedConflicts(
      config,
      backend.identity,
      acceptedState(config, head, journal.accepted ?? journal.after, journal.progress),
      journal.accepted ?? journal.after,
      journal.upload,
      captureMutationOwner(ctx, signal),
    ),
  );
  await validate();
  return true;
}

// Older valid journals may have accepted noncanonical JSON before projection normalization.
function matchesAcceptedState(
  state: Awaited<ReturnType<typeof readStateForConfig>>,
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  progress?: PartialProgress,
) {
  return [true, false].some(
    (canonical) =>
      syncStateFingerprint(state) === syncStateFingerprint(acceptedState(config, head, snapshot, progress, canonical)),
  );
}

function acceptedState(
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  progress?: PartialProgress,
  canonical = true,
) {
  if (progress) return progressState(config, head, snapshot, progress);
  return {
    version: 1,
    profile: config.snapshotIdentity,
    lastAppliedSnapshot: head.snapshotId,
    lastRemoteRevision: head.revision,
    lastFileHashes: fileHashMap(canonical ? portableSnapshot(snapshot, config.localFields) : snapshot),
    include: [...config.include],
    ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
  };
}

async function writeAcceptedState(
  config: AnySyncConfig,
  head: RemoteHead,
  snapshot: Snapshot,
  validate: () => Promise<void>,
  progress?: PartialProgress,
) {
  const accepted = portableSnapshot(snapshot, config.localFields);
  const state = acceptedState(config, head, accepted, progress);
  await stageMergeBaseline(config, accepted, state, progress?.previous);
  await validate();
  await writeStateForConfig(config, state);
  await validate();
}
