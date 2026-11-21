import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireHandover } from "../../consent.js";
import { documentFingerprint } from "../../document.js";
import { type Execution, MAX_REVIEW_BYTES } from "../../protocol.js";
import { createServiceContext } from "../../service-host.js";
import { createSyncBackend } from "../backends/backend-factory.js";
import type { RemoteHead } from "../backends/sync-backend.js";
import { type EngineContext, engineHost } from "../host.js";
import { configFromSettings } from "../settings/config.js";
import {
  type LocalConfigDocument,
  peekLocalConfigDocument,
  updateLocalConfigDocument,
} from "../settings/config-file.js";
import type { AnySyncConfig, PiSyncSettingsV3, SyncSetupSettings } from "../settings/settings-types.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import { syncDirectory } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { stateDir, withStateDirectoryAccess } from "../state/state-directory.js";
import { requireNoMergeJournal } from "../sync/merge-journal.js";
import { configuredSnapshotPathMatcher } from "../sync/sync-policy.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { compileEffectiveIgnorePolicy } from "./effective-ignore-policy.js";
import { prepareDefaultIgnoreSource } from "./ignore-initialization.js";
import { assertCurrentIgnoreMigrationOffer } from "./ignore-migration-prompt.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_CREATION_RECORD,
  DEFAULT_IGNORE_FILENAME,
  DEFAULT_IGNORE_RULES,
  IgnoreCreationPendingError,
  type IgnoreSource,
  ignoreSourceDigest,
  readIgnoreSource,
  validateIgnoreFilename,
} from "./ignore-source.js";

function sourceToken(document: LocalConfigDocument | undefined) {
  return documentFingerprint(
    document ? { bytes: document.bytes.toString("base64"), identity: document.identity } : undefined,
  );
}

function settingsReviewGuard(document: LocalConfigDocument, execution: Execution) {
  const token = sourceToken(document);
  return (candidate: LocalConfigDocument | undefined) => {
    execution.validate();
    if (document.path !== candidate?.path || token !== sourceToken(candidate)) stale();
  };
}

function ignoreFilename(setup: SyncSetupSettings | undefined) {
  return setup?.sync.pathPolicy === "ignore-file"
    ? validateIgnoreFilename(setup.sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME)
    : undefined;
}

function configuredFilenames(settings: PiSyncSettingsV3) {
  return Object.values(settings.syncSetups).flatMap((setup) => {
    const filename = ignoreFilename(setup);
    return filename ? [filename] : [];
  });
}

export function newIgnoreFilename(before: PiSyncSettingsV3 | undefined, next: PiSyncSettingsV3) {
  let added: string | undefined;
  for (const [name, setup] of Object.entries(next.syncSetups)) {
    const previous = before && Object.hasOwn(before.syncSetups, name) ? before.syncSetups[name] : undefined;
    const filename = ignoreFilename(setup);
    if (previous && ignoreFilename(previous) !== filename) {
      throw new Error("Use the reviewed Pi Sync ignore-file settings flow to change an existing setup policy.");
    }
    if (!previous && filename) {
      if (added !== undefined) throw new Error("Create one ignore-file setup at a time so its policy can be reviewed.");
      added = filename;
    }
  }
  return added;
}

type ReviewedIgnoreSource = IgnoreSource & { pendingCreation?: string };

async function readSetupSource(root: string, filename: string, signal: AbortSignal): Promise<ReviewedIgnoreSource> {
  try {
    return await readIgnoreSource(root, filename, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (
      filename !== DEFAULT_IGNORE_FILENAME ||
      !(error instanceof Error) ||
      !(error.cause instanceof IgnoreCreationPendingError)
    )
      throw error;
    if ((await fs.realpath(root)) !== root) throw error;
    const marker = await fs.lstat(path.join(root, DEFAULT_IGNORE_CREATION_RECORD), { bigint: true });
    signal.throwIfAborted();
    if (!marker.isFile() || marker.nlink !== 1n) throw error;
    return {
      filename,
      present: false,
      text: DEFAULT_IGNORE_RULES,
      sourceDigest: ignoreSourceDigest(filename, false, Buffer.from(DEFAULT_IGNORE_RULES)),
      pendingCreation: `${marker.dev}:${marker.ino}:${marker.size}:${marker.ctimeNs}:${marker.mtimeNs}`,
    };
  }
}

export async function reviewNewIgnoreSource(root: string, filename: string, execution: Execution) {
  const ctx = requireInteractive(execution);
  const source = await readSetupSource(root, filename, execution.signal);
  execution.validate();
  compileIgnoreRules(source.text);
  const description = describeSource(source);
  if (
    !(await confirm(
      ctx,
      execution,
      "Review ignore-file policy",
      [
        `Rules: ${safeTerminalText(path.join(root, filename))}`,
        description,
        "Every eligible path not excluded by the rules can be synced, including new files added later.",
        "Saving this setup does not transfer files. Review the selected content before transferring.",
      ].join("\n"),
    ))
  )
    throw new Error("Setup cancelled; no settings or rule files were saved.");
  return source;
}

export async function prepareReviewedIgnoreSource(root: string, reviewed: ReviewedIgnoreSource, execution: Execution) {
  execution.validate();
  const current = await readSetupSource(root, reviewed.filename, execution.signal);
  execution.validate();
  if (
    current.sourceDigest !== reviewed.sourceDigest ||
    current.identity !== reviewed.identity ||
    current.pendingCreation !== reviewed.pendingCreation
  )
    stale();
  if (current.present) return { source: current, created: false };
  const prepared = await prepareDefaultIgnoreSource(root, execution.signal);
  execution.validate();
  if (
    !prepared.source.present ||
    prepared.source.text !== reviewed.text ||
    (!current.pendingCreation && !prepared.created)
  )
    stale();
  return prepared;
}

export async function switchIgnoreFile(
  execution: Execution,
  setupName: string,
  filename: string,
  expectedFilename: string,
) {
  const ctx = requireInteractive(execution);
  filename = validateIgnoreFilename(filename);
  expectedFilename = validateIgnoreFilename(expectedFilename);
  await requireHandover(execution);
  execution.validate();
  return withStateDirectoryAccess(() =>
    withLock("sync", async () => {
      const document = await peekLocalConfigDocument();
      execution.validate();
      if (!document) throw new Error("No Pi Sync settings are configured.");
      const settings = validateSettingsDocument(document.parsed);
      const setup = Object.hasOwn(settings.syncSetups, setupName) ? settings.syncSetups[setupName] : undefined;
      if (ignoreFilename(setup) !== expectedFilename) stale();
      if (expectedFilename === filename) return "saved";
      if ((await pendingTransactionEntries()).some((entry) => entry.isDirectory()))
        throw new Error("Resolve pending local recovery before changing the content policy.");
      await requireNoMergeJournal(configFromSettings(settings, setupName));
      const source = await readIgnoreSource(execution.root, filename, execution.signal);
      execution.validate();
      if (!source.present)
        throw new Error(`Ignore file does not exist: ${safeTerminalText(path.join(execution.root, filename))}`);
      compileIgnoreRules(source.text);
      if (
        !(await confirm(
          ctx,
          execution,
          "Review changing the ignore file",
          [
            `Setup: ${safeTerminalText(setupName)}`,
            `Existing rule file to use: ${safeTerminalText(path.join(execution.root, filename))}`,
            "Changing the file can add or remove paths from future transfers. No transfer starts when you save.",
          ].join("\n"),
        ))
      )
        return "cancelled";
      await updateLocalConfigDocument(
        settings,
        (next) => {
          next.syncSetups[setupName].sync.ignoreFile = filename;
          return next;
        },
        validateSettingsDocument,
        execution.signal,
        settingsReviewGuard(document, execution),
        async () => {
          await prepareReviewedIgnoreSource(execution.root, source, execution);
        },
      );
      execution.committed();
      return "saved";
    }),
  );
}

export async function migrateIgnoreSetup(execution: Execution, setupName: string, offerToken?: string) {
  const ctx = requireInteractive(execution);
  await requireHandover(execution);
  execution.validate();
  return withStateDirectoryAccess(() =>
    withLock("sync", async () => {
      const document = await peekLocalConfigDocument();
      execution.validate();
      if (!document) throw new Error("No Pi Sync settings to migrate.");
      if (offerToken !== undefined) assertCurrentIgnoreMigrationOffer(document, execution.root, setupName, offerToken);
      const before = validateSettingsDocument(document.parsed);
      const setup = Object.hasOwn(before.syncSetups, setupName) ? before.syncSetups[setupName] : undefined;
      if (!setup || ignoreFilename(setup)) throw new Error("Choose a legacy Pi Sync setup to migrate.");
      const previous = configFromSettings(before, setupName);
      if ((await pendingTransactionEntries()).some((entry) => entry.isDirectory())) {
        throw new Error("Resolve pending local recovery before changing the content policy.");
      }
      await requireNoMergeJournal(previous);
      execution.validate();
      const next = structuredClone(before);
      const policy = next.syncSetups[setupName].sync;
      const { include: _include, exclude: _exclude, reinclude: _reinclude, ...common } = policy;
      const sessions =
        policy.scope === "agent-directory" ? policy.sessions === true : previous.include.includes("sessions");
      next.syncSetups[setupName].sync = { ...common, scope: "agent-directory", sessions, pathPolicy: "ignore-file" };
      next.version = 8;
      validateSettingsDocument(next);
      const source = await readSetupSource(execution.root, DEFAULT_IGNORE_FILENAME, execution.signal);
      execution.validate();
      const current = {
        ...configFromSettings(next, setupName),
        ignorePolicy: compileEffectiveIgnorePolicy(source, {
          sessions,
          configuredFilenames: configuredFilenames(next),
        }),
      };
      const backend = await createSyncBackend(previous);
      execution.validate();
      const head = await backend.readHead(execution.signal);
      execution.validate();
      const remote = head ? await backend.readSnapshot(head.snapshotRef, execution.signal) : undefined;
      execution.validate();
      if (head && remote?.id !== head.snapshotId) throw new Error("The remote snapshot changed during inspection.");
      const collectPaths = async (config: AnySyncConfig) => {
        const options = await resolvedSnapshotOptionsForContext(ctx, config, execution.signal);
        execution.validate();
        const image = await createSnapshot(config.snapshotIdentity, options);
        execution.validate();
        return image.files.map(({ path }) => path).sort();
      };
      const collect = async (createdStarter?: string) => {
        const oldPaths = (await collectPaths(previous)).filter((name) => name !== createdStarter);
        const newPaths = await collectPaths(current);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([oldPaths, newPaths]))
          .digest("hex");
        return { oldPaths, newPaths, fingerprint };
      };
      const review = await collect();
      execution.validate();
      const remotePaths = remote?.files.map(({ path }) => path) ?? [];
      const content = [
        `Destination: ${safeTerminalText(backend.destination)}`,
        `Ignore file: ${safeTerminalText(path.join(execution.root, source.filename))}`,
        describeSource(source),
        "Directory-wide selection also applies to future files. Legacy rules are not translated automatically.",
        "Migration changes this setup only. No transfer starts and retained history is not erased.",
        ...describeChanges("Local", review.oldPaths, review.newPaths),
        ...(remote
          ? describeChanges(
              "Remote",
              remotePaths.filter(configuredSnapshotPathMatcher(previous)),
              remotePaths.filter(configuredSnapshotPathMatcher(current)),
            )
          : ["Remote: no published snapshot."]),
      ].join("\n");
      if (!(await confirm(ctx, execution, "Review migration to ignore-file policy", content))) return "cancelled";
      const verifyHead = (fresh: RemoteHead | undefined) => {
        if (
          head
            ? !fresh || head.snapshotId !== fresh.snapshotId || !backend.sameRevision(head.revision, fresh.revision)
            : fresh
        )
          stale();
      };
      await updateLocalConfigDocument(
        next,
        () => next,
        validateSettingsDocument,
        execution.signal,
        settingsReviewGuard(document, execution),
        async () => {
          verifyHead(await backend.readHead(execution.signal));
          execution.validate();
          if (!source.present && (await collect()).fingerprint !== review.fingerprint) stale();
          execution.validate();
          const { source: prepared, created } = await prepareReviewedIgnoreSource(execution.root, source, execution);
          execution.validate();
          await preserveLegacySettings(document);
          execution.validate();
          verifyHead(await backend.readHead(execution.signal));
          execution.validate();
          if ((await collect(created ? prepared.filename : undefined)).fingerprint !== review.fingerprint) stale();
          execution.validate();
          verifyHead(await backend.readHead(execution.signal));
          execution.validate();
          const finalSource = await readIgnoreSource(execution.root, source.filename, execution.signal);
          execution.validate();
          if (
            !finalSource.present ||
            finalSource.sourceDigest !== prepared.sourceDigest ||
            finalSource.identity !== prepared.identity
          )
            stale();
        },
      );
      execution.committed();
      return "saved";
    }),
  );
}

function describeSource(source: ReviewedIgnoreSource) {
  if (source.pendingCreation)
    return "Verify or complete the interrupted creation of the starter rules. Incomplete content will not be used.";
  return source.present
    ? "Keep the existing rule file unchanged."
    : "Create the default rule file with the starter rules.";
}

function describeChanges(label: string, before: string[], after: string[]) {
  const oldPaths = new Set(before);
  const newPaths = new Set(after);
  return [
    `${label} — enters scope:`,
    ...difference(newPaths, oldPaths),
    `${label} — leaves scope:`,
    ...difference(oldPaths, newPaths),
  ];
}

function difference(left: Set<string>, right: Set<string>) {
  const paths = [...left].filter((item) => !right.has(item)).sort();
  return paths.length ? paths.map((item) => `  ${safeTerminalText(item)}`) : ["  none"];
}

async function preserveLegacySettings(document: LocalConfigDocument) {
  const directory = stateDir();
  const target = path.join(directory, `settings-before-ignore-${randomUUID()}.json`);
  const file = await fs.open(target, "wx", 0o600);
  try {
    await file.writeFile(document.bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

function requireInteractive(execution: Execution) {
  const ctx = createServiceContext(execution);
  if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode))
    throw new Error("This policy change requires an interactive review.");
  return ctx;
}

async function confirm(ctx: EngineContext, execution: Execution, title: string, content: string) {
  if (Buffer.byteLength(content) > MAX_REVIEW_BYTES)
    throw new Error("The policy review exceeds its supported size; no changes were saved.");
  const result = await engineHost().review(
    ctx,
    { title, content, confirmationLabel: "Save local policy" },
    execution.signal,
    () => !execution.signal.aborted,
  );
  execution.validate();
  return result;
}

function stale(): never {
  throw new Error("Settings, rule source, or visible content changed. Reopen the Pi Sync policy review.");
}
