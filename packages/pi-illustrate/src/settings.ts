import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type Cols = "auto" | number;
export type MermaidAppearance = "auto" | "dark" | "light";

export interface IllustrateSettings {
  defaultCols: Cols;
  mermaidAppearance: MermaidAppearance;
}

interface SaveOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  apply?: (next: IllustrateSettings, previous: IllustrateSettings) => void;
}

export function defaultSettings(): IllustrateSettings {
  return { defaultCols: "auto", mermaidAppearance: "auto" };
}

export function validCols(value: unknown): value is Cols {
  return value === "auto" || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function validAppearance(value: unknown): value is MermaidAppearance {
  return value === "auto" || value === "dark" || value === "light";
}

class SettingsDocumentError extends Error {}

function validateDocument(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettingsDocumentError("Settings must be a JSON object.");
  }
  const document = value as Record<string, unknown>;
  if (Object.hasOwn(document, "defaultCols") && !validCols(document.defaultCols)) {
    throw new SettingsDocumentError('defaultCols must be "auto" or a positive safe integer.');
  }
  if (Object.hasOwn(document, "mermaidAppearance") && !validAppearance(document.mermaidAppearance)) {
    throw new SettingsDocumentError('mermaidAppearance must be "auto", "dark", or "light".');
  }
  return document;
}

function effective(document: Record<string, unknown>): IllustrateSettings {
  return {
    defaultCols: validCols(document.defaultCols) ? document.defaultCols : "auto",
    mermaidAppearance: validAppearance(document.mermaidAppearance) ? document.mermaidAppearance : "auto",
  };
}

function assertCurrent(options: SaveOptions): void {
  options.signal?.throwIfAborted();
  if (options.isCurrent && !options.isCurrent()) throw new DOMException("Settings owner changed.", "AbortError");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readWarning(error: unknown): string {
  if (error instanceof SettingsDocumentError) return `Cannot load Illustrate settings: ${error.message}`;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const suffix = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,23}$/.test(code) ? ` (${code})` : "";
  return `Cannot load Illustrate settings: Cannot read the settings file${suffix}.`;
}

function applySettings(apply: SaveOptions["apply"], next: IllustrateSettings, previous: IllustrateSettings): void {
  const result: unknown = apply?.({ ...next }, { ...previous });
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    // Reject a programming error without letting an unowned promise block settings or shutdown.
    void Promise.resolve(result).catch(() => undefined);
    throw new TypeError("Settings apply must be synchronous.");
  }
}

/** User-only storage with in-process ordering; this is not a cross-process lock. */
export class SettingsStore {
  readonly path: string;
  private current = defaultSettings();
  private pending: Promise<void> = Promise.resolve();

  constructor(agentDir: string) {
    this.path = resolve(agentDir, "pi-illustrate.json");
  }

  get settings(): IllustrateSettings {
    return { ...this.current };
  }

  load(): Promise<{ settings: IllustrateSettings; warning?: string }> {
    return this.enqueue(async () => {
      const { document } = await this.read();
      this.current = effective(document);
      return { settings: this.settings };
    }).catch((error: unknown) => ({ settings: this.settings, warning: readWarning(error) }));
  }

  async save(patch: Partial<IllustrateSettings>, options: SaveOptions = {}): Promise<IllustrateSettings> {
    validateDocument(patch);
    if (Reflect.ownKeys(patch).some((key) => key !== "defaultCols" && key !== "mermaidAppearance")) {
      throw new SettingsDocumentError("Unknown settings patch field.");
    }
    const owned: Partial<IllustrateSettings> = {};
    if (Object.hasOwn(patch, "defaultCols")) owned.defaultCols = patch.defaultCols;
    if (Object.hasOwn(patch, "mermaidAppearance")) owned.mermaidAppearance = patch.mermaidAppearance;
    validateDocument(owned);
    return this.enqueue(async () => {
      assertCurrent(options);
      const { document, raw } = await this.read();
      assertCurrent(options);
      const nextDocument = { ...document, ...owned };
      const next = effective(nextDocument);
      const previous = this.settings;
      let applied = false;
      let published = false;
      try {
        await this.publish(`${JSON.stringify(nextDocument, null, 2)}\n`, options, () => {
          this.current = next;
          applied = true;
          applySettings(options.apply, next, previous);
          assertCurrent(options);
        });
        published = true;
        assertCurrent(options);
        return this.settings;
      } catch (error) {
        this.current = previous;
        const errors: unknown[] = [error];
        if (applied) {
          try {
            applySettings(options.apply, previous, next);
          } catch (rollbackError) {
            errors.push(rollbackError);
          }
        }
        // Cancellation can arrive while rename is in flight. Restore the original
        // bytes before releasing the queue; a failed restore remains observable.
        if (published) {
          try {
            if (raw === undefined) await fs.rm(this.path, { force: true });
            else await this.publish(raw);
          } catch (rollbackError) {
            errors.push(rollbackError);
          }
        }
        if (errors.length > 1) throw new AggregateError(errors, "Settings save and rollback failed.");
        throw error;
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Register immediately: deferring behind this store's last task would let
    // another store overtake an earlier user action on the same path.
    const result = withFileMutationQueue(this.path, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending = Promise.all([this.pending, settled]).then(() => undefined);
    return result;
  }

  private async read(): Promise<{ document: Record<string, unknown>; raw?: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (error) {
      if (missing(error)) return { document: {} };
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new SettingsDocumentError("Settings file is not valid JSON.");
    }
    return { raw, document: validateDocument(document) };
  }

  private async publish(raw: string, options: SaveOptions = {}, beforeRename?: () => void): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(this.path), { recursive: true });
    assertCurrent(options);
    try {
      await fs.writeFile(temporary, raw, { encoding: "utf8", mode: 0o600, flag: "wx", signal: options.signal });
      assertCurrent(options);
      beforeRename?.();
      assertCurrent(options);
      await fs.rename(temporary, this.path);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}
