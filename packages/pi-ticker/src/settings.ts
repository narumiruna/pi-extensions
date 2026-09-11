import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_SYMBOLS = 10;
export const DEFAULT_WIDGET_ENABLED = true;

export interface StockTickerSettings {
  symbols: string[];
  widgetEnabled: boolean;
}

export interface LoadedSettings {
  settings: StockTickerSettings;
  warning?: string;
}

export interface SettingsWriter {
  save(path: string, symbols: readonly string[]): Promise<void>;
  saveWidgetEnabled(path: string, widgetEnabled: boolean): Promise<void>;
  flush(): Promise<void>;
}

const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,15}$/;

export function parseSymbols(values: Iterable<string>): string[] {
  return normalizeSymbols(values, false);
}

export function normalizeSymbols(values: Iterable<string>, allowEmpty: boolean): string[] {
  const symbols = [...values]
    .flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(symbols)];
  if (!allowEmpty && unique.length === 0) throw new Error("Provide at least one stock symbol.");
  if (unique.length > MAX_SYMBOLS) {
    throw new Error(`At most ${MAX_SYMBOLS} stock symbols are supported.`);
  }
  const invalid = unique.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid stock symbol: ${invalid}`);
  return unique;
}

export async function loadSettings(path: string): Promise<LoadedSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { settings: defaultSettings() };
    return {
      settings: defaultSettings(),
      warning: `Could not read ${path}; using default ticker settings.`,
    };
  }

  try {
    const document = parseDocument(text);
    const symbols = document.symbols === undefined ? [] : parseSymbolSetting(document.symbols);
    const widgetEnabled =
      document.widgetEnabled === undefined ? DEFAULT_WIDGET_ENABLED : parseWidgetEnabled(document.widgetEnabled);
    return { settings: { symbols, widgetEnabled } };
  } catch (error) {
    return {
      settings: defaultSettings(),
      warning: `${errorMessage(error)} Using default ticker settings without changing ${path}.`,
    };
  }
}

export async function saveSymbols(path: string, symbols: readonly string[]): Promise<void> {
  await saveSettingsPatch(path, { symbols: normalizeSymbols(symbols, true) });
}

export async function saveWidgetEnabled(path: string, widgetEnabled: boolean): Promise<void> {
  await saveSettingsPatch(path, { widgetEnabled: parseWidgetEnabled(widgetEnabled) });
}

export function createSettingsWriter(): SettingsWriter {
  let queue = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const running = queue.catch(() => undefined).then(operation);
    queue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };
  return {
    save: (path, symbols) => enqueue(() => saveSymbols(path, symbols)),
    saveWidgetEnabled: (path, widgetEnabled) => enqueue(() => saveWidgetEnabled(path, widgetEnabled)),
    flush: () => queue,
  };
}

async function saveSettingsPatch(path: string, patch: Partial<StockTickerSettings>): Promise<void> {
  let document: Record<string, unknown> = {};
  try {
    const text = await readFile(path, "utf8");
    document = parseDocument(text);
    validateKnownSettings(document);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const next = `${JSON.stringify({ ...document, ...patch }, null, 2)}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function defaultSettings(): StockTickerSettings {
  return { symbols: [], widgetEnabled: DEFAULT_WIDGET_ENABLED };
}

function parseDocument(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Stock ticker settings must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stock ticker settings must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function validateKnownSettings(document: Record<string, unknown>): void {
  if (document.symbols !== undefined) parseSymbolSetting(document.symbols);
  if (document.widgetEnabled !== undefined) parseWidgetEnabled(document.widgetEnabled);
}

function parseSymbolSetting(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("The stock ticker symbols setting must be an array of strings.");
  }
  return normalizeSymbols(value as string[], true);
}

function parseWidgetEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("The stock ticker widgetEnabled setting must be a boolean.");
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
