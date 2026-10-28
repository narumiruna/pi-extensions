import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { BUILT_IN_EXAMPLE, type LoadedStarshipConfig, validateConfigDocument } from "./config.js";
import type { settingsSnapshots } from "./settings-snapshots.js";

const MAX_DRAFT_BYTES = 64 * 1024;

export interface SettingsDraftOptions {
  settingsPath: string;
  baseline: Buffer | undefined;
  packageRoot: string;
  snapshots?: ReturnType<typeof settingsSnapshots>;
  isCurrent(): boolean;
  onPreview(loaded: LoadedStarshipConfig): void;
}

/** Private file tools; the active settings path is only an immutable read snapshot. */
export function createSettingsDraft(options: SettingsDraftOptions) {
  if (options.baseline && options.baseline.length > MAX_DRAFT_BYTES)
    throw new Error("The settings draft exceeds 64 KiB");
  const roots = ["skills/configure-pi-starship", "src"].map((part) => realpathSync(join(options.packageRoot, part)));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-starship-draft-")));
  const path = join(directory, "pi-starship.toml");
  const baseline = options.baseline && Buffer.from(options.baseline);
  const snapshots = new Map(
    Object.entries(options.snapshots ?? {}).map(([name, content]) => [join(directory, name), content]),
  );
  const snapshotPaths = [...snapshots.keys()];
  let disposed = false;
  let removed = false;
  let revision = 0;
  let valid: LoadedStarshipConfig | undefined;
  let diagnostics = "";
  const assertCurrent = () => {
    if (disposed || !options.isCurrent()) throw new Error("The settings draft owner is no longer active");
  };
  const assertDraft = (target: string) => {
    assertCurrent();
    if (resolve(target) !== path || realpathSync(directory) !== directory || realpathSync(path) !== path) {
      throw new Error("Only the owned settings draft can be changed");
    }
  };
  const readDraft = () => {
    assertDraft(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_DRAFT_BYTES)
        throw new Error("The owned draft is not a private regular file up to 64 KiB");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const validate = (publish = true) => {
    valid = undefined;
    let candidate: LoadedStarshipConfig;
    try {
      candidate = validateConfigDocument(options.settingsPath, readDraft().toString("utf8"));
    } catch (error) {
      diagnostics = error instanceof Error ? error.message : String(error);
      return;
    }
    diagnostics = candidate.diagnostics.map((item) => `${item.severity}: ${item.path}: ${item.message}`).join("\n");
    if (publish) options.onPreview(candidate);
    valid = candidate;
  };
  try {
    writeFileSync(path, baseline ?? BUILT_IN_EXAMPLE, { mode: 0o600, flag: "wx" });
    validate(false);
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Settings draft initialization and cleanup failed at ${directory}`,
      );
    }
    throw error;
  }
  const readAllowed = (target: string): Buffer => {
    assertCurrent();
    if (resolve(target) === resolve(options.settingsPath)) {
      if (!baseline) throw new Error("The active settings file was missing when this preview started");
      return Buffer.from(baseline);
    }
    if (resolve(target) === path) return readDraft();
    if (snapshots.has(resolve(target))) {
      const content = snapshots.get(resolve(target));
      if (content === undefined)
        throw new Error(
          "No exact loaded settings document is available; read active-state.json for its source and diagnostics",
        );
      return Buffer.from(content);
    }
    const canonical = realpathSync(target);
    if (
      !roots.some((root) => {
        const child = relative(root, canonical);
        return (
          child !== "" &&
          child !== ".." &&
          !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
          !isAbsolute(child)
        );
      })
    )
      throw new Error("Read access is limited to the settings snapshot, draft, and bundled configuration documents");
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw new Error("Only bundled text documents up to 1 MiB can be read");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const writeDraft = async (target: string, text: string) => {
    assertDraft(target);
    if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) throw new Error("The settings draft exceeds 64 KiB");
    const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("The owned draft is not a private regular file");
      // Keep validation and preview in the core tool's mutation queue, without an await boundary.
      valid = undefined;
      ftruncateSync(fd, 0);
      writeFileSync(fd, text);
    } catch (error) {
      diagnostics = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      closeSync(fd);
    }
    revision += 1;
    validate();
    if (!valid)
      throw new Error(
        `Draft saved but preview rejected; repair the draft. ${truncateHead(diagnostics, { maxBytes: 48 * 1024, maxLines: 1900 }).content}`,
      );
  };
  const read = createReadTool(directory, {
    operations: {
      access: async (target) => {
        readAllowed(target);
      },
      readFile: async (target) => readAllowed(target),
    },
  });
  const write = createWriteTool(directory, {
    operations: {
      mkdir: async (target) => {
        assertCurrent();
        if (target !== directory) throw new Error("Only the draft directory is writable");
      },
      writeFile: writeDraft,
    },
  });
  const edit = createEditTool(directory, {
    operations: {
      access: async (target) => assertDraft(target),
      readFile: async (target) => {
        assertDraft(target);
        return readDraft();
      },
      writeFile: writeDraft,
    },
  });
  read.description =
    "Read text from immutable disk/active configuration and module snapshots, the owned draft, or bundled configuration skill/source documents. Output is limited to 50 KiB or 2,000 lines; use offset and limit to continue.";
  write.description =
    "Replace only the owned pi-starship TOML draft, up to 64 KiB. The host validates and previews it. Invalid text stays in the draft and returns an error for repair. Never writes the active settings file.";
  edit.description +=
    " Only the owned pi-starship TOML draft is editable. The host validates and previews the result; invalid text stays in the draft for repair. Never changes active settings.";
  // The outer queue includes reads and result diagnostics. Core mutators retain their
  // own file-path queue; a distinct directory key avoids recursive queue admission.
  const ordered = <T>(operation: () => Promise<T>) =>
    withFileMutationQueue(directory, async () => {
      assertCurrent();
      const result = await operation();
      assertCurrent();
      return result;
    });
  const readExecute = read.execute.bind(read);
  read.execute = (...args) => ordered(() => readExecute(...args));
  const warningResult = async <T extends { content: Awaited<ReturnType<typeof read.execute>>["content"] }>(
    operation: Promise<T>,
  ): Promise<T> => {
    const result = await operation;
    assertCurrent();
    return {
      ...result,
      content: [
        ...result.content,
        {
          type: "text" as const,
          text: truncateHead(`Draft validated. Preview updated; active settings unchanged.\n${diagnostics}`, {
            maxBytes: 48 * 1024,
            maxLines: 1900,
          }).content,
        },
      ],
    };
  };
  const writeExecute = write.execute.bind(write);
  write.execute = (...args) => ordered(() => warningResult(writeExecute(...args)));
  const editExecute = edit.execute.bind(edit);
  edit.execute = (...args) => ordered(() => warningResult(editExecute(...args)));
  return {
    directory,
    path,
    snapshotPaths,
    tools: [read, write, edit] as [typeof read, typeof write, typeof edit],
    get revision() {
      return revision;
    },
    get candidate() {
      return valid;
    },
    get rawDocument() {
      return readDraft().toString("utf8");
    },
    get diagnostics() {
      return diagnostics;
    },
    assertRevision(expected: number) {
      assertCurrent();
      if (revision !== expected || !valid || valid.rawDocument !== readDraft().toString("utf8"))
        throw new Error("The settings draft changed after review");
    },
    dispose() {
      disposed = true;
      if (removed) return;
      rmSync(directory, { recursive: true, force: true });
      removed = true;
    },
  };
}
export type SettingsDraft = ReturnType<typeof createSettingsDraft>;
