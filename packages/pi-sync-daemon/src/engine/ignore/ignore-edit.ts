import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { type Execution, record } from "../../protocol.js";
import { getEngineRoot } from "../host.js";
import { type LocalConfigDocument, withLockedLocalConfigDocument } from "../settings/config-file.js";
import { validateConfigName, validateSettingsDocument } from "../settings/settings-validation.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_CREATION_RECORD,
  DEFAULT_IGNORE_FILENAME,
  ignoreFileIdentity,
  readIgnoreSource,
  sameFile,
} from "./ignore-source.js";

type IgnoreLocation = { filename: string; path: string; sharingSetups: string[] };
type IgnoreEdit = IgnoreLocation & { text: string; sourceDigest: string; identity: string };
type EditorSource = { location: IgnoreLocation; existing?: { view: IgnoreEdit; stat: BigIntStats } };

function locateIgnoreFile(document: LocalConfigDocument | undefined, root: string, setup: string): IgnoreLocation {
  const settings = document && validateSettingsDocument(document.parsed);
  const current = settings && Object.hasOwn(settings.syncSetups, setup) ? settings.syncSetups[setup] : undefined;
  if (!settings || !current) throw new Error("Sync setup no longer exists; reopen ignore-file settings.");
  if (current.sync.pathPolicy !== "ignore-file") throw new Error("This sync setup does not use an ignore file.");
  const filename = current.sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME;
  return {
    filename,
    path: path.join(root, filename),
    sharingSetups: Object.entries(settings.syncSetups)
      .filter(
        ([name, { sync }]) =>
          name !== setup &&
          sync.scope === "agent-directory" &&
          sync.pathPolicy === "ignore-file" &&
          (sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME) === filename,
      )
      .map(([name]) => name)
      .sort(),
  };
}

function statAt(target: string) {
  return lstatSync(target, { bigint: true, throwIfNoEntry: false });
}

function stale(target: string): never {
  throw new Error(`Ignore file changed or disappeared at "${target}"; reopen ignore-file settings.`);
}

function assertCurrent(target: string, expected: BigIntStats | undefined) {
  const current = statAt(target);
  if (expected ? !current || !sameFile(expected, current) : current) stale(target);
}

function validateTarget(execution: Execution, location: IgnoreLocation) {
  execution.validate();
  const root = getEngineRoot();
  if (location.filename === DEFAULT_IGNORE_FILENAME && statAt(path.join(root, DEFAULT_IGNORE_CREATION_RECORD))) {
    throw new Error(`Ignore file "${location.path}" has an unfinished creation record; repair it before editing.`);
  }
  const target = statAt(location.path);
  if (
    target &&
    execution.liveClients().some(({ sessionFile }) => {
      const session = sessionFile && statSync(sessionFile, { bigint: true, throwIfNoEntry: false });
      return session && target.dev === session.dev && target.ino === session.ino;
    })
  )
    throw new Error(`Ignore file "${location.path}" is a protected live session.`);
  return { root, target };
}

function editorDigest(setup: string, location: IgnoreLocation, sourceDigest: string) {
  return createHash("sha256")
    .update(JSON.stringify(["pi-sync-ignore-editor-v1", setup, sourceDigest, location.sharingSetups]))
    .digest("hex");
}

async function loadEditorSource(setup: string, location: IgnoreLocation, execution: Execution): Promise<EditorSource> {
  const { root, target: stat } = validateTarget(execution, location);
  if (!stat) return { location };
  try {
    const source = await readIgnoreSource(root, location.filename, execution.signal);
    validateTarget(execution, location);
    assertCurrent(location.path, stat);
    if (!source.present || source.identity !== ignoreFileIdentity(stat)) stale(location.path);
    compileIgnoreRules(source.text);
    const { text, identity } = source;
    return {
      location,
      existing: {
        view: { ...location, text, sourceDigest: editorDigest(setup, location, source.sourceDigest), identity },
        stat,
      },
    };
  } catch (cause) {
    execution.validate();
    throw new Error(`Cannot open ignore file "${location.path}": ${(cause as Error).message}`, { cause });
  }
}

export async function readIgnoreFileEdit(payload: unknown, execution: Execution): Promise<IgnoreLocation | IgnoreEdit> {
  if (!record(payload) || typeof payload.setup !== "string" || Object.keys(payload).some((key) => key !== "setup"))
    throw new Error("Invalid ignore-file request.");
  const { setup } = payload;
  validateConfigName(setup, "sync setup");
  const source = await withLockedLocalConfigDocument(async (document, recheck) => {
    execution.validate();
    const location = locateIgnoreFile(document, getEngineRoot(), setup);
    const result = await loadEditorSource(setup, location, execution);
    validateTarget(execution, location);
    recheck();
    assertCurrent(location.path, result.existing?.stat);
    return result;
  }, execution.signal);
  validateTarget(execution, source.location);
  assertCurrent(source.location.path, source.existing?.stat);
  return source.existing?.view ?? source.location;
}
