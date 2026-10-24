import { constants } from "node:fs";
import fs, { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface SubagentSettings {
  showWidget: boolean;
  showJobId: boolean;
  showTools: boolean;
  showTiming: boolean;
}

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = Object.freeze({
  showWidget: true,
  showJobId: true,
  showTools: true,
  showTiming: true,
});

const SETTINGS_KEYS = Object.keys(DEFAULT_SUBAGENT_SETTINGS) as (keyof SubagentSettings)[];

type SettingsDocument = {
  document?: Record<string, unknown>;
  diagnostics: string[];
};

export function subagentSettingsPath(): string {
  return join(getAgentDir(), "pi-subagents.json");
}

/** User-only settings with in-process ordering; this does not lock other Pi processes. */
export class SubagentSettingsStore {
  private effective: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly userPath: string) {}

  get settings(): SubagentSettings {
    return { ...this.effective };
  }

  load(): Promise<{ settings: SubagentSettings; diagnostics: string[] }> {
    return this.enqueue(async () => {
      const loaded = await readDocument(this.userPath);
      const settings = normalizeSettings(loaded.document ?? {}, loaded.diagnostics);
      this.effective = settings;
      return { settings: this.settings, diagnostics: loaded.diagnostics };
    }).catch((error: unknown) => ({
      settings: this.settings,
      diagnostics: [readDiagnostic(this.userPath, error)],
    }));
  }

  save(key: keyof SubagentSettings, value: boolean, signal: AbortSignal): Promise<SubagentSettings> {
    return this.enqueue(async () => {
      signal.throwIfAborted();
      if (!SETTINGS_KEYS.includes(key) || typeof value !== "boolean") {
        throw new Error("Invalid subagent settings update");
      }
      const loaded = await readDocument(this.userPath);
      signal.throwIfAborted();
      if (!loaded.document) {
        throw new Error(`Cannot save subagent settings: ${loaded.diagnostics.join("; ")}`);
      }
      // Read again for each save and patch only the requested key, including after a failed save.
      const document = { ...loaded.document, [key]: value };
      const settings = normalizeSettings(document, []);
      const parent = dirname(this.userPath);
      await fs.mkdir(parent, { recursive: true });
      signal.throwIfAborted();
      const temporary = await fs.mkdtemp(join(parent, ".pi-subagents-"));
      try {
        signal.throwIfAborted();
        const staged = join(temporary, "settings.json");
        await fs.writeFile(staged, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", signal });
        signal.throwIfAborted();
        await fs.rename(staged, this.userPath);
        // Rename is the commit point. Cancellation or cleanup must not turn a commit into a failure.
        this.effective = settings;
        return this.settings;
      } finally {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    // Register immediately so other stores and Pi file operations retain request order too.
    const result = withFileMutationQueue(this.userPath, async () => {
      await previous;
      return operation();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

async function readSettingsText(path: string): Promise<string | undefined> {
  // Both consumers reject special files before reading; nonblocking open covers a path-type race.
  if (!(await lstat(path)).isFile()) return undefined;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readDocument(path: string): Promise<SettingsDocument> {
  let text: string;
  try {
    const source = await readSettingsText(path);
    if (source === undefined) {
      return {
        diagnostics: [
          `Cannot load subagent settings at ${path}: expected a regular file, not a symlink or special file`,
        ],
      };
    }
    text = source;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { document: {}, diagnostics: [] };
    }
    return { diagnostics: [readDiagnostic(path, error)] };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { diagnostics: [`Cannot load subagent settings at ${path}: invalid JSON`] };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { diagnostics: [`Cannot load subagent settings at ${path}: expected a JSON object`] };
  }
  return { document: document as Record<string, unknown>, diagnostics: [] };
}

function normalizeSettings(document: Record<string, unknown>, diagnostics: string[]): SubagentSettings {
  const settings = { ...DEFAULT_SUBAGENT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(document, key)) continue;
    if (typeof document[key] === "boolean") {
      settings[key] = document[key];
    } else {
      diagnostics.push(`Ignored invalid subagent setting ${key}: expected a boolean`);
    }
  }
  return settings;
}

function readDiagnostic(path: string, error: unknown): string {
  return `Cannot load subagent settings at ${path}: ${error instanceof Error ? error.message : String(error)}`;
}

export interface SubagentsSettings {
  durable: boolean;
  warnings: string[];
}

/** Read manual settings without creating files. Call again at the next session/reload boundary. */
export async function loadSubagentsSettings(cwd: string, projectTrusted: boolean): Promise<SubagentsSettings> {
  const userPath = subagentSettingsPath();
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-subagents.json");
  const warnings: string[] = [];
  let durable = false;
  try {
    // Share the widget save queue so reload cannot read a pre-save user document.
    durable = (await withFileMutationQueue(userPath, () => readDurableOverride(userPath, "user", warnings))) ?? false;
  } catch {
    // Queue path resolution can fail before the reader runs. Keep these errors private too.
    warnings.push("pi-subagents user settings ignored: could not read the file.");
  }
  if (projectTrusted) durable = (await readDurableOverride(projectPath, "project", warnings)) ?? durable;
  return { durable, warnings };
}

async function readDurableOverride(
  path: string,
  scope: "user" | "project",
  warnings: string[],
): Promise<boolean | undefined> {
  // Fixed messages bound warning data and exclude file contents, paths, and raw I/O errors.
  const warn = (reason: string): undefined => {
    warnings.push(`pi-subagents ${scope} settings ignored: ${reason}.`);
    return undefined;
  };

  let source: string;
  try {
    // Final symlinks are rejected; ancestor symlinks follow normal filesystem semantics.
    const text = await readSettingsText(path);
    if (text === undefined) return warn("expected a regular file, not a symlink or special file");
    source = text;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    return warn("could not read the file");
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch {
    return warn("invalid JSON");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return warn("expected a JSON object");
  }
  if (!Object.hasOwn(document, "durable")) return undefined;
  const durable = (document as Record<string, unknown>).durable;
  if (typeof durable !== "boolean") return warn('"durable" must be a boolean');
  return durable;
}
