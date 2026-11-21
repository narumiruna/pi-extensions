import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { withCleanup } from "../../lifecycle.js";
import { type Execution, record } from "../../protocol.js";
import { getEngineRoot, withEngineMutationQueue } from "../host.js";
import { type LocalConfigDocument, withLockedLocalConfigDocument } from "../settings/config-file.js";
import { validateConfigName, validateSettingsDocument } from "../settings/settings-validation.js";
import {
  compileIgnoreRules,
  DEFAULT_IGNORE_CREATION_RECORD,
  DEFAULT_IGNORE_FILENAME,
  ignoreFileIdentity,
  ignoreSourceDigest,
  MAX_IGNORE_BYTES,
  readIgnoreSource,
  sameFile,
  sameIdentity,
} from "./ignore-source.js";

type IgnoreLocation = { filename: string; path: string; sharingSetups: string[] };
type IgnoreEdit = IgnoreLocation & { text: string; sourceDigest: string; identity: string };
type EditorSource = { location: IgnoreLocation; existing?: { view: IgnoreEdit; stat: BigIntStats } };
const flush = promisify(fsync);
const safeReadFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

function readSetup(payload: unknown, fields: readonly string[]) {
  if (
    !record(payload) ||
    typeof payload.setup !== "string" ||
    Object.keys(payload).some((key) => !fields.includes(key))
  )
    throw new Error("Invalid ignore-file request.");
  validateConfigName(payload.setup, "sync setup");
  return payload.setup;
}

function locateIgnoreFile(document: LocalConfigDocument | undefined, root: string, setup: string): IgnoreLocation {
  const settings = document && validateSettingsDocument(document.parsed);
  const current = settings && Object.hasOwn(settings.syncSetups, setup) ? settings.syncSetups[setup] : undefined;
  if (!current) throw new Error("Sync setup no longer exists; reopen ignore-file settings.");
  if (settings?.version !== 8 || current.sync.scope !== "agent-directory" || current.sync.pathPolicy !== "ignore-file")
    throw new Error("This sync setup does not use an ignore file.");
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
  throw new Error(`Ignore file changed or disappeared at "${target}"; reopen the editor before saving.`);
}

function assertCurrent(target: string, expected: BigIntStats | undefined) {
  const current = statAt(target);
  if (expected ? !current || !sameFile(expected, current) : current) stale(target);
}

function assertNoIncompleteCreation(root: string, location: IgnoreLocation) {
  if (location.filename === DEFAULT_IGNORE_FILENAME && statAt(path.join(root, DEFAULT_IGNORE_CREATION_RECORD))) {
    throw new Error(`Ignore file "${location.path}" has an unfinished creation record; repair it before editing.`);
  }
}

function validateTarget(execution: Execution, target: string) {
  execution.validate();
  const root = getEngineRoot();
  if (execution.liveClients().some((peer) => peer.sessionFile && path.resolve(peer.sessionFile) === target))
    throw new Error(`Ignore file "${target}" is a protected live session.`);
  return root;
}

function editorDigest(setup: string, location: IgnoreLocation, sourceDigest: string) {
  return createHash("sha256")
    .update(JSON.stringify(["pi-sync-ignore-editor-v1", setup, sourceDigest, location.sharingSetups]))
    .digest("hex");
}

async function loadEditorSource(setup: string, location: IgnoreLocation, execution: Execution): Promise<EditorSource> {
  const root = validateTarget(execution, location.path);
  assertNoIncompleteCreation(root, location);
  const stat = statAt(location.path);
  if (!stat) return { location };
  try {
    const source = await readIgnoreSource(root, location.filename, execution.signal);
    validateTarget(execution, location.path);
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

function readForSetup(setup: string, execution: Execution): Promise<EditorSource> {
  return withLockedLocalConfigDocument(async (document, recheck) => {
    execution.validate();
    const location = locateIgnoreFile(document, getEngineRoot(), setup);
    const result = await loadEditorSource(setup, location, execution);
    const root = validateTarget(execution, location.path);
    recheck();
    assertNoIncompleteCreation(root, location);
    assertCurrent(location.path, result.existing?.stat);
    return result;
  }, execution.signal);
}

export async function readIgnoreFileEdit(payload: unknown, execution: Execution): Promise<IgnoreLocation | IgnoreEdit> {
  const setup = readSetup(payload, ["setup"]);
  const source = await readForSetup(setup, execution);
  const root = validateTarget(execution, source.location.path);
  assertNoIncompleteCreation(root, source.location);
  assertCurrent(source.location.path, source.existing?.stat);
  return source.existing?.view ?? source.location;
}

function assertExactBytes(target: string, stat: BigIntStats, expected: Buffer) {
  if (!stat.isFile() || stat.nlink !== 1n) stale(target);
  assertCurrent(target, stat);
  const fd = openSync(target, safeReadFlags);
  try {
    if (!sameFile(stat, fstatSync(fd, { bigint: true }))) stale(target);
    const bytes = Buffer.alloc(expected.length + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count !== expected.length || !bytes.subarray(0, count).equals(expected)) stale(target);
    if (!sameFile(stat, fstatSync(fd, { bigint: true }))) stale(target);
    assertCurrent(target, stat);
  } finally {
    closeSync(fd);
  }
}

async function replaceExisting(
  setup: string,
  root: string,
  current: NonNullable<EditorSource["existing"]>,
  text: string,
  recheck: () => void,
  validate: () => void,
  onCommit: () => void,
): Promise<IgnoreEdit> {
  const target = current.view.path;
  const reviewedBytes = Buffer.from(current.view.text);
  const nextBytes = Buffer.from(text);
  const temporary = path.join(root, `.pi-sync.json.ignore-edit-${randomUUID()}.tmp`);
  const temporaryFd = openSync(temporary, "wx", 0o600);
  let created: BigIntStats | undefined;
  let staged: BigIntStats | undefined;
  let installed = false;
  return withCleanup(
    async () => {
      try {
        created = fstatSync(temporaryFd, { bigint: true });
        writeFileSync(temporaryFd, nextBytes);
        staged = fstatSync(temporaryFd, { bigint: true });
        await flush(temporaryFd);
      } finally {
        closeSync(temporaryFd);
      }
      validate();
      const directory =
        process.platform === "win32" ? undefined : openSync(root, safeReadFlags | constants.O_DIRECTORY);
      try {
        assertExactBytes(temporary, staged, nextBytes);
        assertExactBytes(target, current.stat, reviewedBytes);
        recheck();
        validate();
        assertNoIncompleteCreation(root, current.view);
        assertCurrent(temporary, staged);
        assertCurrent(target, current.stat);
        renameSync(temporary, target);
        installed = true;
        onCommit();
        if (directory !== undefined) {
          try {
            await flush(directory);
          } catch (cause) {
            throw new Error(`Ignore file "${target}" was replaced but its durability could not be verified.`, {
              cause,
            });
          }
        }
        getEngineRoot();
        const saved = statAt(target);
        if (!saved || saved.dev !== staged.dev || saved.ino !== staged.ino) stale(target);
        assertExactBytes(target, saved, nextBytes);
        return {
          ...current.view,
          text,
          sourceDigest: editorDigest(setup, current.view, ignoreSourceDigest(current.view.filename, true, nextBytes)),
          identity: ignoreFileIdentity(saved),
        };
      } finally {
        if (directory !== undefined) closeSync(directory);
      }
    },
    async () => {
      if (!installed) {
        getEngineRoot();
        const pending = statAt(temporary);
        if (pending && (staged ? sameFile(staged, pending) : created && sameIdentity(created, pending)))
          unlinkSync(temporary);
      }
    },
  );
}

export async function saveIgnoreFileEdit(
  payload: unknown,
  execution: Execution,
  handover: () => Promise<void>,
  validateHandover: () => void,
): Promise<IgnoreEdit> {
  const setup = readSetup(payload, ["setup", "text", "sourceDigest", "identity"]);
  if (
    !record(payload) ||
    typeof payload.text !== "string" ||
    payload.text.length > MAX_IGNORE_BYTES ||
    typeof payload.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.sourceDigest) ||
    typeof payload.identity !== "string" ||
    payload.identity.length > 128 ||
    !/^-?\d+:\d+:-?\d+$/u.test(payload.identity)
  )
    throw new Error("Invalid ignore-file save request (text exceeds the byte limit or review evidence is invalid).");
  const { text, identity, sourceDigest } = payload;
  compileIgnoreRules(text);
  const currentClient = () => {
    execution.validate();
    if (!execution.clientId || !execution.facts()) throw new Error("Saving an ignore file requires a current client.");
  };
  const checkReview = ({ location, existing }: EditorSource) => {
    if (!existing || existing.view.identity !== identity || existing.view.sourceDigest !== sourceDigest)
      stale(location.path);
    return existing;
  };
  currentClient();
  const beforeHandover = await readForSetup(setup, execution);
  currentClient();
  checkReview(beforeHandover);
  await handover();
  currentClient();
  const target = beforeHandover.location.path;
  const validate = () => {
    currentClient();
    validateTarget(execution, target);
    validateHandover();
  };
  validate();
  return withEngineMutationQueue(target, () =>
    withLockedLocalConfigDocument(
      async (document, recheck) => {
        validate();
        const root = getEngineRoot();
        const location = locateIgnoreFile(document, root, setup);
        if (location.path !== target) stale(target);
        const source = await loadEditorSource(setup, location, execution);
        validate();
        const current = checkReview(source);
        if (text === current.view.text) {
          recheck();
          validate();
          assertNoIncompleteCreation(root, location);
          assertCurrent(target, current.stat);
          return current.view;
        }
        return replaceExisting(setup, root, current, text, recheck, validate, () => execution.committed());
      },
      execution.signal,
      true,
    ),
  );
}
