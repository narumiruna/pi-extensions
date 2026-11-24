import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { requireHandover } from "../../consent.js";
import { documentFingerprint } from "../../document.js";
import { type Execution, MAX_REVIEW_BYTES, record } from "../../protocol.js";
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
import { validateConfigName, validateSettingsDocument } from "../settings/settings-validation.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import { syncDirectory } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { stateDir, withStateDirectoryAccess } from "../state/state-directory.js";
import { requireNoMergeJournal } from "../sync/merge-journal.js";
import { configuredSnapshotPathMatcher } from "../sync/sync-policy.js";
import { safeTerminalText, snapshotPathLabel } from "../ui/terminal-text.js";
import { compileEffectiveIgnorePolicy } from "./effective-ignore-policy.js";
import {
  AutomaticIgnoreCreationUnavailable,
  checkAutomaticIgnoreCreation,
  prepareDefaultIgnoreSource,
  readPendingIgnoreCreation,
} from "./ignore-initialization.js";
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

export function runIgnorePolicyChange(
  operation: "ignore.migrate" | "ignore.switch",
  payload: unknown,
  execution: Execution,
) {
  if (!record(payload) || typeof payload.setup !== "string") throw new Error("Invalid ignore-file policy request.");
  const { setup } = payload;
  validateConfigName(setup, "sync setup");
  if (operation === "ignore.migrate") {
    const { offerToken } = payload;
    if (
      Object.keys(payload).some((key) => key !== "setup" && key !== "offerToken") ||
      (offerToken !== undefined && (typeof offerToken !== "string" || !/^[a-f0-9]{64}$/u.test(offerToken)))
    )
      throw new Error("Invalid ignore-file migration request.");
    if (offerToken !== undefined && execution.facts()?.mode !== "tui")
      throw new Error("Ignore migration offers require an attached TUI client.");
    return migrateIgnoreSetup(execution, setup, offerToken);
  }
  const { filename, expectedFilename } = payload;
  if (
    typeof filename !== "string" ||
    typeof expectedFilename !== "string" ||
    Object.keys(payload).some((key) => key !== "setup" && key !== "filename" && key !== "expectedFilename")
  )
    throw new Error("Invalid ignore-file switch request.");
  return switchIgnoreFile(execution, setup, filename, expectedFilename);
}

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
    const { text, token } = await readPendingIgnoreCreation(root, signal);
    signal.throwIfAborted();
    return {
      filename,
      present: false,
      text,
      sourceDigest: ignoreSourceDigest(filename, false, Buffer.from(text)),
      pendingCreation: token,
    };
  }
}

async function readPolicyReviewSource(root: string, filename: string, execution: Execution, allowCreation: boolean) {
  const { signal } = execution;
  execution.validate();
  signal.throwIfAborted();
  filename = validateIgnoreFilename(filename);
  if (
    filename !== DEFAULT_IGNORE_FILENAME &&
    lstatSync(path.resolve(root), { throwIfNoEntry: false })?.isDirectory() &&
    !lstatSync(path.resolve(root, filename), { throwIfNoEntry: false })
  ) {
    throw manualCreationRequired(root, filename);
  }
  const source = await (allowCreation
    ? readSetupSource(root, filename, signal)
    : readIgnoreSource(root, filename, signal));
  execution.validate();
  if (source.present) return source;
  if (!allowCreation) throw manualCreationRequired(root, filename);
  await checkAutomaticIgnoreCreation(root, signal).catch((error: unknown) => {
    execution.validate();
    throw creationFailure(root, source, error);
  });
  execution.validate();
  return source;
}

function manualCreationRequired(root: string, filename: string, cause?: Error) {
  return new Error(
    `Ignore file does not exist: ${snapshotPathLabel(path.resolve(root, filename))}\n` +
      `${cause ? `${cause.message}. ` : ""}Create a regular UTF-8 text file there manually with these starter rules, then retry the Pi Sync policy change:\n${DEFAULT_IGNORE_RULES}`,
    { cause },
  );
}

function creationFailure(root: string, source: ReviewedIgnoreSource, error: unknown) {
  if (!(error instanceof AutomaticIgnoreCreationUnavailable)) return error;
  if (!source.pendingCreation) return manualCreationRequired(root, source.filename, error);
  return new Error(
    `Interrupted creation of ${snapshotPathLabel(path.resolve(root, source.filename))}. ${error.message}. ` +
      `Preserve the rule file and creation record ${snapshotPathLabel(path.resolve(root, DEFAULT_IGNORE_CREATION_RECORD))}. ` +
      "Retry the reviewed Pi Sync policy change where safe automatic recovery is available.",
    { cause: error },
  );
}

export async function reviewNewIgnoreSource(root: string, filename: string, execution: Execution) {
  const ctx = requireInteractive(execution);
  const source = await readPolicyReviewSource(root, filename, execution, true);
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
  const prepared = await prepareDefaultIgnoreSource(root, execution.signal, current.pendingCreation ?? null).catch(
    (error: unknown) => {
      execution.validate();
      throw creationFailure(root, current, error);
    },
  );
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
  if (expectedFilename !== filename) {
    await readPolicyReviewSource(execution.root, filename, execution, false);
    execution.validate();
  }
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
      const source = await readPolicyReviewSource(execution.root, filename, execution, false);
      execution.validate();
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
  await readPolicyReviewSource(execution.root, DEFAULT_IGNORE_FILENAME, execution, true);
  execution.validate();
  await requireHandover(execution);
  execution.validate();
  return withStateDirectoryAccess(() =>
    withLock("sync", async () => {
      const document = await peekLocalConfigDocument();
      execution.validate();
      if (!document) throw new Error("No Pi Sync settings to migrate.");
      const guardSettings = settingsReviewGuard(document, execution);
      const validateReview = (candidate: LocalConfigDocument | undefined) => {
        guardSettings(candidate);
        if (offerToken !== undefined)
          assertCurrentIgnoreMigrationOffer(candidate, execution.root, setupName, offerToken);
      };
      validateReview(document);
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
      if (next.version < 8) next.version = 8;
      validateSettingsDocument(next);
      const source = await readPolicyReviewSource(execution.root, DEFAULT_IGNORE_FILENAME, execution, true);
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
        validateReview,
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
  if (source.present) return "Keep the existing rule file unchanged.";
  const action = source.pendingCreation
    ? "Verify or complete the interrupted creation of the starter rules. Incomplete content will not be used."
    : "Create the default rule file with the starter rules.";
  return `${action}\n${source.text.trimEnd()}`;
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
