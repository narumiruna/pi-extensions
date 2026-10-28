import { type ExtensionCommandContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ConfigurationCommandOptions, WorkflowOwner } from "./command-configuration.js";
import {
  assertConfigDocumentUnchanged,
  atomicRestoreConfigDocument,
  atomicSaveConfigDocument,
  type ConfigDocumentSnapshot,
  ConfigPublicationError,
  type LoadedStarshipConfig,
  readConfigDocumentSnapshot,
  removeConfigDocumentIfMatches,
  validateConfigDocument,
} from "./config.js";
import { archiveConfigDocument } from "./profile-store.js";

export interface CommitOptions extends ConfigurationCommandOptions {
  save?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
  restore?: (settingsPath: string, rawDocument: string) => void;
  archive?: typeof archiveConfigDocument;
}

export interface CommitExpectation {
  previous: LoadedStarshipConfig;
  revision: number | undefined;
  disk: ConfigDocumentSnapshot;
}

export function captureCommitExpectation(options: ConfigurationCommandOptions): CommitExpectation {
  return {
    previous: options.getLoaded(),
    revision: options.getLoadedRevision?.(),
    disk: readConfigDocumentSnapshot(options.settingsPath),
  };
}

export function commitOwnerCurrent(
  options: ConfigurationCommandOptions,
  owner: WorkflowOwner,
  expected: CommitExpectation,
): boolean {
  const loaded = options.getLoaded();
  return (
    !owner.signal.aborted &&
    owner.isCurrent() &&
    loaded.rawDocument === expected.previous.rawDocument &&
    loaded.source === expected.previous.source &&
    JSON.stringify(loaded.diagnostics) === JSON.stringify(expected.previous.diagnostics) &&
    options.getLoadedRevision?.() === expected.revision
  );
}

/** The queue has asynchronous admission; the owned file/runtime transaction has no await boundary. */
export async function commitActiveDocument(
  ctx: ExtensionCommandContext,
  options: CommitOptions,
  candidate: LoadedStarshipConfig,
  owner: WorkflowOwner,
  expected: CommitExpectation,
  allowInvalid = false,
  checkCandidate?: () => void,
  restoreNative = false,
): Promise<"applied" | "cancel"> {
  const raw = candidate.rawDocument;
  if (restoreNative) {
    if (raw !== undefined || candidate.source !== "built-in" || candidate.diagnostics.length > 0)
      throw new Error("The native footer candidate is invalid");
  } else if (raw === undefined) throw new Error("The candidate settings document is unavailable");
  return withFileMutationQueue(options.settingsPath, async () => {
    if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
    checkCandidate?.();
    assertConfigDocumentUnchanged(options.settingsPath, expected.disk);
    const previousBytes = expected.disk.rawBytes;
    if (expected.previous.rawDocument !== previousBytes?.toString("utf8")) {
      throw new Error(
        "The active file differs from the loaded document. Reload and review it before replacing settings.",
      );
    }
    const invalid = expected.previous.diagnostics.some((item) => item.severity === "error");
    if (invalid && !allowInvalid)
      throw new Error("The active settings document is invalid. Use explicit repair or recovery before replacing it.");
    // Always validate again at the publication boundary, not only in the preview layer.
    if (raw !== undefined) {
      validateConfigDocument(options.settingsPath, raw);
      if (previousBytes?.equals(Buffer.from(raw))) return "applied";
    }

    let recoveryPath: string | undefined;
    if (previousBytes !== undefined) {
      recoveryPath = (options.archive ?? archiveConfigDocument)(options.settingsPath, previousBytes).path;
    }
    // A recovery publication can fail or observe an external edit. Never publish over that edit.
    try {
      assertConfigDocumentUnchanged(options.settingsPath, expected.disk);
      if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
      checkCandidate?.();
    } catch (error) {
      throw new Error(`${message(error)}.${recoveryNote(recoveryPath)}`);
    }
    let saved: LoadedStarshipConfig;
    try {
      if (raw === undefined) {
        if (previousBytes !== undefined) {
          if (!expected.disk.fileIdentity) throw new Error("The settings document identity is unavailable");
          removeConfigDocumentIfMatches(
            options.settingsPath,
            previousBytes.toString("utf8"),
            expected.disk.fileIdentity,
          );
        }
        saved = candidate;
      } else {
        saved = options.save
          ? options.save(options.settingsPath, raw)
          : atomicSaveConfigDocument(options.settingsPath, raw, {}, expected.disk);
      }
    } catch (error) {
      if (restoreNative) {
        const rollback = restorePrevious(ctx, options, owner, expected, undefined, undefined, false);
        throw new Error(
          `Pi native footer was not restored: ${message(error)}. ${rollback}${recoveryNote(recoveryPath)}`,
        );
      }
      if (error instanceof ConfigPublicationError) {
        const rollback = restorePrevious(ctx, options, owner, expected, raw, error.fileIdentity, false);
        throw new Error(`Footer settings were not saved: ${message(error)}. ${rollback}${recoveryNote(recoveryPath)}`);
      }
      throw new Error(
        `Footer settings were not saved: ${message(error)}. The previous footer remains active.${recoveryNote(recoveryPath)}`,
      );
    }
    try {
      if (
        owner.signal.aborted ||
        !(owner.isSessionCurrent?.() ?? owner.isCurrent()) ||
        options.getLoadedRevision?.() !== expected.revision
      ) {
        throw new Error("The configuration owner changed during publication");
      }
      options.apply(saved, ctx);
    } catch (error) {
      const rollback = restorePrevious(ctx, options, owner, expected, raw, saved.fileIdentity, true);
      throw new Error(
        `Footer settings could not be applied: ${message(error)}. ${rollback}${recoveryNote(recoveryPath)}`,
      );
    }
    return "applied";
  });
}

function restorePrevious(
  ctx: ExtensionCommandContext,
  options: CommitOptions,
  owner: WorkflowOwner,
  expected: CommitExpectation,
  raw: string | undefined,
  identity: LoadedStarshipConfig["fileIdentity"],
  restoreRuntime: boolean,
): string {
  try {
    if (owner.signal.aborted || !(owner.isSessionCurrent?.() ?? owner.isCurrent()))
      throw new Error("The session owner changed; stale restoration was blocked");
    const current = options.getLoaded();
    if (current.rawDocument !== expected.previous.rawDocument && current.rawDocument !== raw) {
      throw new Error("The active runtime changed; stale restoration was blocked");
    }
    if (raw === undefined) {
      const disk = readConfigDocumentSnapshot(options.settingsPath);
      if (disk.rawBytes !== undefined) {
        assertConfigDocumentUnchanged(options.settingsPath, expected.disk);
      } else if (expected.disk.rawBytes !== undefined) {
        atomicRestoreConfigDocument(options.settingsPath, expected.disk.rawBytes, {}, disk);
      }
      if (restoreRuntime) options.apply(expected.previous, ctx);
      return "The previous configuration was restored.";
    }
    if (!identity) throw new Error("The saved settings document identity is unavailable");
    assertConfigDocumentUnchanged(options.settingsPath, { rawBytes: Buffer.from(raw), fileIdentity: identity });
    if (expected.disk.rawBytes === undefined) {
      removeConfigDocumentIfMatches(options.settingsPath, raw, identity);
    } else if (options.restore && expected.disk.rawBytes.equals(Buffer.from(expected.previous.rawDocument ?? ""))) {
      options.restore(options.settingsPath, expected.previous.rawDocument ?? "");
    } else {
      atomicRestoreConfigDocument(
        options.settingsPath,
        expected.disk.rawBytes,
        {},
        { rawBytes: Buffer.from(raw), fileIdentity: identity },
      );
    }
    if (restoreRuntime) options.apply(expected.previous, ctx);
    return "The previous configuration was restored.";
  } catch (error) {
    return `Restoring the previous configuration also failed: ${message(error)}. Active path: ${options.settingsPath}.`;
  }
}

function recoveryNote(path: string | undefined): string {
  return path ? ` Recovery copy retained: ${path}.` : "";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
