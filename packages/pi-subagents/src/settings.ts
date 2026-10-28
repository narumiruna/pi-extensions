import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface SubagentSettings {
  showWidget: boolean;
  showJobId: boolean;
  showTools: boolean;
  showTiming: boolean;
}

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = Object.freeze({
  showWidget: true,
  showJobId: false,
  showTools: false,
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

async function readDocument(path: string): Promise<SettingsDocument> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
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
