import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import { type EngineContext, getEngineRoot, withEngineMutationQueue } from "../host.js";
import {
  type AdoptionJournal,
  completeAdoptionJournal,
  createAdoptionJournal,
  recordInstalledIdentity,
  verifyAdoptionBackup,
} from "../ignore/adoption-journal.js";
import {
  DEFAULT_IGNORE_FILENAME,
  ignoreFileIdentity,
  ignorePolicyFingerprint,
  ignoreSourceDigest,
  readIgnoreSource,
  sameFile,
} from "../ignore/ignore-source.js";
import { validateSnapshotIgnoreRules } from "../ignore/snapshot-ignore-rules.js";
import { loadConfigForCheck, syncConfigReviewFingerprint, syncSettingsConfigFingerprint } from "../settings/config.js";
import { readActiveLocalConfigDocumentForRepair, withLockedLocalConfigDocument } from "../settings/config-file.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { effectiveSessionRoot, requireStableMergeSessionRoot } from "../snapshot/session-paths.js";
import { createSnapshot, filterSnapshotForConfigPolicy, regenerateSnapshotIdentity } from "../snapshot/snapshot.js";
import { appliedFileHashMap, applySnapshot } from "../snapshot/snapshot-apply.js";
import { recoverPendingSnapshotTransactions } from "../snapshot/snapshot-transaction.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import { syncDirectory } from "../state/json-file.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../state/sync-state-store.js";
import { formatRuleChanges } from "../ui/ignore-rule-preview.js";
import { formatPullSummary, formatTransferReview, type TransferReview } from "../ui/sync-format.js";
import { snapshotPathLabel } from "../ui/terminal-text.js";
import { confirmTransferReview } from "../ui/transfer-review.js";
import { inspectCaseCleanup, revalidateCaseCleanup } from "./apply-review.js";
import { checkpointDirectionalAction, localRestoreGuidance, notifyDirectionalSuccess } from "./directional-action.js";
import { overlayLocalFields, portableSnapshot, sameLocalFields } from "./local-fields.js";
import { readMergeJournal } from "./merge-journal.js";
import { readSnapshotForHead, sameRemoteHead } from "./remote-snapshot.js";
import { backupDirectionalSnapshot, captureMutationOwner, maybeReload, protectedSessionPaths } from "./sync-local.js";
import { acceptedSelection, fileHashMap, rawSnapshotHashIdentity, sameHashes } from "./sync-state.js";
import { checkLiveProtection } from "./transfer-freshness.js";
import { requireTransferSize, selectedPullImage, transferSizeLimitsEnabled } from "./transfer-size-limits.js";

export function canReviewAdoption(ctx: EngineContext, options: CommandOptions) {
  return (
    ctx.hasUI &&
    (ctx.mode === "tui" || ctx.mode === "rpc") &&
    !options.auto &&
    !options.background &&
    !options.yes &&
    !options.agentRetryRefusal
  );
}

export function adoptionSettingsFingerprint(config: AnySyncConfig) {
  return syncConfigReviewFingerprint({ ...config, ignorePolicy: undefined, ignoreSourceIdentity: undefined });
}

function scopeChangeReview(label: string, paths: readonly string[]): TransferReview {
  if (!paths.length) return { lines: [], content: "" };
  return {
    lines: [`${label}: ${paths.length} file(s). View details for paths.`],
    content: paths.map((name) => `${label}: ${snapshotPathLabel(name)}`).join("\n"),
  };
}

async function assertDedicatedSource(config: AnySyncConfig, filename: string) {
  const doc = await readActiveLocalConfigDocumentForRepair();
  if (!doc) throw new Error("Sync setup no longer exists; reopen Pull.");
  const settings = validateSettingsDocument(doc.parsed);
  if (
    Object.entries(settings.syncSetups).some(
      ([name, setup]) =>
        name !== config.setupName &&
        setup.sync.pathPolicy === "ignore-file" &&
        (setup.sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME).toLowerCase() === filename.toLowerCase(),
    )
  )
    throw new Error("The ignore file is shared by other setups. Select a dedicated rule file before Pull.");
  return doc;
}

function assertNotLiveRuleTarget(ctx: EngineContext, target: string, identity: string) {
  const live = [...(ctx.protectedSessionFiles ?? []), ctx.sessionManager.getSessionFile?.()];
  for (const entry of live) {
    if (!entry) continue;
    const stat = statSync(entry, { bigint: true, throwIfNoEntry: false });
    if (path.resolve(entry) === target || (stat && ignoreFileIdentity(stat) === identity))
      throw new Error("The rule file is a protected live session; Pull cannot replace it.");
  }
}

interface AdoptionInput {
  ctx: EngineContext;
  options: CommandOptions;
  config: AnySyncConfig;
  backend: SyncBackend;
  state: SyncState;
  head: RemoteHead;
  remote: Snapshot;
  snapshotOptions: SnapshotOptions;
  validateMutation: () => void;
  journal?: AdoptionJournal;
}

export async function adoptRemoteRules(input: AdoptionInput) {
  const { ctx, options, config, state, backend, head, remote, snapshotOptions, validateMutation } = input;
  const signal = options.signal;
  const validateCommittedOwner = captureMutationOwner(ctx);
  if (!canReviewAdoption(ctx, options) || !config.ignorePolicy)
    throw new Error("Rule adoption requires a reviewed foreground Pull.");
  const remotePolicy = validateSnapshotIgnoreRules(remote);
  if (!remotePolicy || !remote.ignoreRules) {
    throw new Error(
      remote.ignoreRules === null
        ? "Remote rules exclude their own file. Match the publisher's rules manually before Pull."
        : "Remote snapshot does not contain rule text. Match the publisher's rules or publish a new snapshot first.",
    );
  }
  const { text } = remote.ignoreRules;
  const { filename, sessions, reservedNames } = config.ignorePolicy;
  if (sessions !== remotePolicy.sessions)
    throw new Error("Sessions opt-in differs. Review your local Sessions setting and reopen Pull.");
  if (remotePolicy.matches(filename))
    throw new Error(
      "The remote rules exclude this setup's rule filename. Review a matching rule filename before Pull.",
    );
  if (!sameLocalFields(config.localFields, remote.localFields))
    throw new Error("Machine-local field policy differs. Match that policy before adopting remote ignore rules.");
  const root = getEngineRoot();
  const target = path.join(root, filename);
  const source = await readIgnoreSource(root, filename, signal);
  if (
    !source.present ||
    source.identity !== config.ignoreSourceIdentity ||
    source.sourceDigest !== config.ignorePolicy.sourceDigest
  )
    throw new Error("Local ignore source changed; reopen Pull.");
  const doc = await assertDedicatedSource(config, filename);
  validateMutation();
  assertNotLiveRuleTarget(ctx, target, source.identity);
  if (state.unresolved?.length || (await readMergeJournal(config)))
    throw new Error("Resolve or recover pending merge work before adopting rules.");
  const adoptedPolicy = {
    ...remotePolicy,
    filename,
    reservedNames,
    sourceDigest: ignoreSourceDigest(filename, true, Buffer.from(text)),
  };
  const setupFingerprint = adoptionSettingsFingerprint(config);
  const settingsFreshness = syncSettingsConfigFingerprint(config);
  const stateFingerprint = syncStateFingerprint(state);
  const sessionDir = snapshotOptions.sessionDir;
  const protectedPaths = protectedSessionPaths(ctx, sessionDir);
  const remoteFilesIdentity = rawSnapshotHashIdentity(remote);
  const resuming = input.journal !== undefined;
  let current = input.journal;
  if (
    current &&
    (current.setupName !== config.setupName ||
      current.setupFingerprint !== setupFingerprint ||
      current.filename !== filename ||
      current.afterRules !== text ||
      current.remoteFilesIdentity !== remoteFilesIdentity ||
      current.sessionDir !== sessionDir ||
      !sameRemoteHead(backend, current.head, head) ||
      (source.text === text
        ? current.installedIdentity !== source.identity
        : current.beforeRules !== source.text || current.sourceIdentity !== source.identity))
  )
    throw new Error("Pending rule adoption no longer matches this setup, source, or remote. Preserve its journal.");
  if (!current && (await pendingTransactionEntries()).length)
    throw new Error("Recover the pending file transaction before adopting rules.");
  const policyConfig = { ...config, ignorePolicy: adoptedPolicy };
  const validateSource = async () => {
    validateMutation();
    const latest = await loadConfigForCheck(config.setupName, signal);
    validateMutation();
    if (
      getEngineRoot() !== root ||
      latest.configDocumentFingerprint !== config.configDocumentFingerprint ||
      syncSettingsConfigFingerprint(latest) !== settingsFreshness ||
      latest.ignoreSourceIdentity !== source.identity ||
      latest.ignorePolicy?.sourceDigest !== source.sourceDigest
    )
      throw new Error("Local rules or settings changed during Pull; reopen the review.");
    assertNotLiveRuleTarget(ctx, target, source.identity);
    checkLiveProtection(ctx, sessionDir, protectedPaths);
  };
  const projected = {
    ...snapshotOptions,
    ignorePolicy: adoptedPolicy,
    ignoreSourceIdentity: current?.sourceIdentity ?? source.identity,
    validateMutation,
    validateIgnorePolicy: validateSource,
  };
  const logical = portableSnapshot(filterSnapshotForConfigPolicy(remote, policyConfig, projected), config.localFields);
  let before = await createSnapshot(config.snapshotIdentity, projected);
  let physical = overlayLocalFields(logical, before, config.localFields);
  const prior = current ? undefined : await createSnapshot(config.snapshotIdentity, snapshotOptions);
  const beforePaths = new Set(before.files.map((file) => file.path));
  const priorPaths = new Set(prior?.files.map((file) => file.path));
  const left = prior?.files.filter((file) => !beforePaths.has(file.path)).map((file) => file.path) ?? [];
  const incomingPaths = new Set(physical.files.map((file) => file.path));
  const newlyRemoved = before.files
    .filter((file) => !priorPaths.has(file.path) && !protectedPaths.has(file.path) && !incomingPaths.has(file.path))
    .map((file) => file.path);
  const caseCleanup = current ? [] : await inspectCaseCleanup(physical, projected);
  requireStableMergeSessionRoot(before, physical, config.scope);
  await validateSource();
  const checkSize = () => {
    if (transferSizeLimitsEnabled(config))
      requireTransferSize(config, selectedPullImage(logical, before, protectedPaths, { filename, text }));
  };
  if (!resuming) checkSize();
  const approved = await confirmTransferReview(
    ctx,
    current ? "Resume reviewed ignore-rule Pull?" : "Overwrite local rules and pull?",
    formatTransferReview(
      `Local rule file: ${snapshotPathLabel(target)}. The remote will not change.`,
      `Sessions opt-in: ${sessions ? "on" : "off"} (unchanged).`,
      ...(current
        ? ["Resume from the recorded snapshot, not the current remote head. Local evidence must still match."]
        : []),
      formatPullSummary(
        policyConfig,
        backend.destination,
        before,
        physical,
        protectedPaths,
        caseCleanup.map((item) => item.path),
      ),
      ...(left.length ? [scopeChangeReview("Now excluded; leave local", left)] : []),
      ...(!current && newlyRemoved.length ? [scopeChangeReview("Newly selected; remove locally", newlyRemoved)] : []),
      formatRuleChanges(current?.beforeRules ?? source.text, text),
    ),
    signal,
    validateMutation,
  );
  if (!approved) return "cancelled" as const;
  await checkpointDirectionalAction(options, {
    direction: "pull",
    config,
    state,
    local: before,
    remote,
    head,
    sessionDir,
    protectedPaths,
  });
  validateMutation();
  const validateHead = async () => {
    if (resuming) return;
    const latestHead = await backend.readHead(signal);
    validateMutation();
    if (!sameRemoteHead(backend, head, latestHead)) throw new Error("Remote changed during Pull; reopen the review.");
  };
  const validateContext = async () => {
    await validateHead();
    if ((await effectiveSessionRoot(ctx, config, signal)) !== sessionDir)
      throw new Error("Session storage changed; reopen Pull.");
    await validateSource();
  };
  const latest = await readSnapshotForHead(backend, head, signal, config);
  if (
    latest.version !== remote.version ||
    latest.ignoreRules?.text !== text ||
    latest.ignoreRules.filename !== remote.ignoreRules.filename ||
    !sameLocalFields(latest.localFields, remote.localFields) ||
    rawSnapshotHashIdentity(latest) !== remoteFilesIdentity
  )
    throw new Error("The reviewed remote snapshot changed; reopen Pull.");
  if (current) await verifyAdoptionBackup(current, signal);
  await validateContext();
  const refresh = async () => {
    const next = await createSnapshot(config.snapshotIdentity, projected);
    await validateSource();
    return next;
  };
  let commitStarted = false;
  const markCommit = () => {
    if (!commitStarted) options.onCommit?.();
    commitStarted = true;
  };
  if (current && (await pendingTransactionEntries()).length) {
    if (source.text === text || current.stateFingerprint !== stateFingerprint)
      throw new Error("Pending local files and rule adoption cannot be reconciled; preserve both journals.");
    markCommit();
    await recoverPendingSnapshotTransactions({ ...projected, protectedTargets: liveSessionFiles(ctx) });
    before = await refresh();
    physical = overlayLocalFields(logical, before, config.localFields);
  }
  if (!current) {
    await revalidateCaseCleanup(caseCleanup, physical, projected);
    if (!sameHashes(fileHashMap(await refresh()), fileHashMap(before)))
      throw new Error("Local files changed; reopen Pull.");
    const backup = await backupDirectionalSnapshot(regenerateSnapshotIdentity(before), signal);
    await validateContext();
    if (syncStateFingerprint(await readStateForConfig(config)) !== stateFingerprint)
      throw new Error("Baseline changed; reopen Pull.");
    await backup.validate();
    await validateSource();
    current = {
      version: 1,
      setupName: config.setupName,
      setupFingerprint,
      stateFingerprint,
      filename,
      sourceIdentity: source.identity,
      beforeRules: source.text,
      afterRules: text,
      beforeFiles: fileHashMap(before),
      afterFiles: appliedFileHashMap(physical, before, protectedPaths),
      head,
      remoteFilesIdentity,
      sessionDir,
      backupId: path.basename(backup.backupPath, ".json.gz"),
      backupDigest: backup.digest,
    };
    markCommit();
    await createAdoptionJournal(current);
  }
  let journal = current;
  const installedHashes = journal.afterFiles;
  const stateFor = (acceptedConfig: AnySyncConfig): SyncState => ({
    version: 1,
    profile: config.snapshotIdentity,
    lastAppliedSnapshot: head.snapshotId,
    lastRemoteRevision: head.revision,
    lastFileHashes: config.localFields?.length
      ? { ...installedHashes, "settings.json": fileHashMap(logical)["settings.json"] }
      : installedHashes,
    ...acceptedSelection(acceptedConfig),
    ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
  });
  const hashes = fileHashMap(await refresh());
  if (resuming && source.text !== text && sameHashes(hashes, journal.beforeFiles)) checkSize();
  if (source.text !== text && journal.stateFingerprint !== stateFingerprint)
    throw new Error("Baseline changed after the reviewed Pull. Preserve its journal.");
  if (!sameHashes(hashes, journal.afterFiles)) {
    if (
      source.text === text ||
      !sameHashes(hashes, journal.beforeFiles) ||
      !sameHashes(appliedFileHashMap(physical, before, protectedPaths), journal.afterFiles)
    )
      throw new Error("Local files changed after the reviewed Pull. Preserve its journal.");
    markCommit();
    await applySnapshot(physical, protectedPaths, {
      ...projected,
      reviewedLocal: before,
      validateApplyReview: async () => {
        await validateContext();
        if (syncStateFingerprint(await readStateForConfig(config)) !== journal.stateFingerprint)
          throw new Error("Baseline changed at Pull's commit boundary.");
      },
    });
  }
  await validateContext();
  if (!sameHashes(fileHashMap(await refresh()), journal.afterFiles))
    throw new Error("Installed files changed before rule adoption completed; preserve the journal.");
  markCommit();
  if (source.text !== text) {
    await withEngineMutationQueue(target, async () => {
      await validateContext();
      if (!sameHashes(fileHashMap(await refresh()), installedHashes))
        throw new Error("Local files changed while reserving the rule file; preserve the journal.");
      await withLockedLocalConfigDocument(
        async (latest, recheck) => {
          if (!latest?.bytes.equals(doc.bytes) || JSON.stringify(latest.identity) !== JSON.stringify(doc.identity))
            throw new Error("Sync settings changed; preserve the journal.");
          await installRuleFile(
            ctx,
            root,
            target,
            source.identity,
            source.sourceDigest,
            filename,
            text,
            signal,
            async (identity) => {
              journal = await recordInstalledIdentity(journal, identity);
              await validateHead();
            },
            () => {
              recheck();
              validateMutation();
              checkLiveProtection(ctx, sessionDir, protectedPaths);
            },
          );
        },
        signal,
        true,
      );
    });
  } else {
    await syncDirectory(root);
    validateCommittedOwner();
  }
  const installed = await loadConfigForCheck(config.setupName);
  if (
    installed.configDocumentFingerprint !== config.configDocumentFingerprint ||
    adoptionSettingsFingerprint(installed) !== setupFingerprint ||
    installed.ignorePolicy?.fingerprint !== ignorePolicyFingerprint(text, sessions) ||
    installed.ignorePolicy?.sourceDigest !== adoptedPolicy.sourceDigest ||
    installed.ignoreSourceIdentity !== journal.installedIdentity
  )
    throw new Error("Cannot verify the installed rule file. Preserve the adoption journal.");
  const finalState = stateFor(installed);
  const latestFingerprint = syncStateFingerprint(await readStateForConfig(installed));
  const validateFinal = () => {
    validateCommittedOwner();
    checkLiveProtection(ctx, sessionDir, protectedPaths);
  };
  validateFinal();
  const installedFiles = await createSnapshot(config.snapshotIdentity, {
    ...projected,
    ignorePolicy: installed.ignorePolicy,
    ignoreSourceIdentity: installed.ignoreSourceIdentity,
    validateMutation: validateFinal,
    validateIgnorePolicy: installed.validateIgnorePolicy,
  });
  if (!sameHashes(fileHashMap(installedFiles), installedHashes))
    throw new Error("Local files changed during adoption. Preserve the journal.");
  await installed.validateIgnorePolicy?.();
  validateFinal();
  if (latestFingerprint === journal.stateFingerprint)
    await writeStateForConfig(installed, finalState, logical, validateFinal);
  else if (latestFingerprint !== syncStateFingerprint(finalState))
    throw new Error("Baseline changed during installation; preserve the adoption journal.");
  validateFinal();
  const archive = await completeAdoptionJournal(journal);
  validateFinal();
  if (!signal?.aborted) {
    notifyDirectionalSuccess(
      ctx,
      options,
      [
        `Adopted remote rules and pulled snapshot ${snapshotPathLabel(head.snapshotId)}.`,
        localRestoreGuidance(path.join(path.dirname(archive), `${journal.backupId}.json.gz`)),
        `Previous rule text: ${snapshotPathLabel(archive)}.`,
      ].join("\n"),
    );
    if (!options.directionalAction && options.reload) await maybeReload(ctx, signal, validateFinal);
  }
  return "applied" as const;
}

function liveSessionFiles(ctx: EngineContext) {
  const current = ctx.sessionManager.getSessionFile?.();
  return [...(ctx.protectedSessionFiles ?? []), ...(current ? [current] : [])];
}

async function installRuleFile(
  ctx: EngineContext,
  root: string,
  target: string,
  identity: string,
  digest: string,
  filename: string,
  text: string,
  signal: AbortSignal | undefined,
  recordIdentity: (identity: string) => Promise<void>,
  validate: () => void,
) {
  const before = lstatSync(target, { bigint: true });
  const temporary = path.join(root, `.pi-sync.json.${randomUUID()}.ignore-adopt`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let temporaryIdentity: string | undefined;
  try {
    let staged: Awaited<ReturnType<typeof handle.stat>>;
    try {
      temporaryIdentity = ignoreFileIdentity(await handle.stat({ bigint: true }));
      await handle.writeFile(text, "utf8");
      if (process.platform !== "win32") await handle.chmod(Number(before.mode & 0o777n));
      await handle.sync();
      staged = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    await recordIdentity(ignoreFileIdentity(staged));
    const current = await readIgnoreSource(root, filename, signal);
    validate();
    signal?.throwIfAborted();
    const after = lstatSync(target, { bigint: true });
    assertNotLiveRuleTarget(ctx, target, identity);
    const stagedNow = lstatSync(temporary, { bigint: true });
    if (
      !sameFile(staged, stagedNow) ||
      stagedNow.nlink !== 1n ||
      !sameFile(before, after) ||
      !current.present ||
      current.identity !== identity ||
      current.sourceDigest !== digest
    )
      throw new Error("Local rule file changed; preserve the adoption journal.");
    renameSync(temporary, target);
    await syncDirectory(root);
  } finally {
    const remaining = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
    if (remaining && ignoreFileIdentity(remaining) === temporaryIdentity) await fs.rm(temporary, { force: true });
  }
}
