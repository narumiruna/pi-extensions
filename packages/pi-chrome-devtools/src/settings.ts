import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";

const NEW_SETTINGS_FILE_NAME = "pi-chrome-devtools.json";
const LEGACY_SETTINGS_FILE_NAME = "pi-chrome-devtools-settings.json";

export interface ChromeDevToolsSettings {
  tools: ChromeDevToolsToolName[];
  updatedAt: number;
}

export const DEFAULT_BROWSER_HOST = "127.0.0.1";
export const DEFAULT_BROWSER_PORT = 9222;
export const DEFAULT_BROWSER_ENDPOINT = `http://${DEFAULT_BROWSER_HOST}:${DEFAULT_BROWSER_PORT}`;

export type BrowserSettingsSource = "default" | "environment" | "project" | "user";

export interface UserBrowserSettings {
  endpoint?: string;
  autoLaunch?: boolean;
  executablePath?: string;
  extensionPaths?: string[];
}

export interface BrowserSettingsPatch {
  endpoint?: string | null;
  autoLaunch?: boolean | null;
  executablePath?: string | null;
}

export interface EffectiveBrowserSettings {
  endpoint: string;
  host: string;
  port: number;
  hostConfigured: boolean;
  portConfigured: boolean;
  autoLaunchEnabled: boolean;
  executablePath?: string;
  extensionPaths: string[];
  endpointSource: BrowserSettingsSource;
  autoLaunchSource: BrowserSettingsSource;
  executablePathSource: BrowserSettingsSource;
  extensionPathsSource: BrowserSettingsSource;
}

export interface ResolvedChromeDevToolsSettings {
  tools?: ChromeDevToolsToolName[];
  updatedAt?: number;
  browser: EffectiveBrowserSettings;
  webmcp: { enabled: boolean };
}

export interface SettingsLoadOptions {
  cwd?: string;
  projectTrusted?: boolean;
}

export type UserSettingsFileStatus = { kind: "missing" | "valid" } | { kind: "invalid"; reason: string };

interface SettingsLoadBase {
  effectiveBrowser: EffectiveBrowserSettings;
  effectiveWebMcpEnabled: boolean;
  paths: { user: string; project?: string };
  userFile: UserSettingsFileStatus;
  warnings: string[];
  notice?: string;
}

export type SettingsLoadResult =
  | (SettingsLoadBase & { kind: "missing"; settings?: undefined })
  | (SettingsLoadBase & { kind: "invalid"; reason: string; settings?: undefined })
  | (SettingsLoadBase & { kind: "loaded"; settings: ResolvedChromeDevToolsSettings });

export interface SettingsFileOperations {
  write(path: string, data: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

interface NormalizedSettingsDocument {
  tools?: ChromeDevToolsToolName[];
  updatedAt?: number;
  browser?: UserBrowserSettings;
  webmcp?: { enabled: boolean };
}

interface SettingsDocumentResult {
  kind: "missing" | "invalid" | "valid";
  reason?: string;
  document?: Record<string, unknown>;
  normalized?: NormalizedSettingsDocument;
  warnings: string[];
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
  write: (path, data) => writeFile(path, data, "utf8").then(() => undefined),
  rename,
};

let settingsSaveQueue = Promise.resolve();

export async function waitForSettingsWrites() {
  await settingsSaveQueue;
}

export async function loadSettings(options: SettingsLoadOptions = {}): Promise<SettingsLoadResult> {
  await settingsSaveQueue;
  const userPath = settingsFilePath();
  const projectPath = options.cwd ? projectSettingsFilePath(options.cwd) : undefined;
  const paths = { user: userPath, ...(projectPath ? { project: projectPath } : {}) };
  const warnings: string[] = [];

  let user = await readSettingsDocument(userPath, "user");
  const legacyExists = await fileExists(legacySettingsFilePath());
  if (user.kind !== "missing" && legacyExists) {
    warnings.push(
      `Chrome DevTools legacy settings ignored: ${legacySettingsFilePath()} exists, but ${userPath} takes precedence. Delete ${LEGACY_SETTINGS_FILE_NAME} after confirming your settings.`,
    );
  }
  if (user.kind === "missing") {
    const legacy = await readSettingsDocument(legacySettingsFilePath(), "user");
    const concurrentlyCreated = await readSettingsDocument(userPath, "user");
    if (concurrentlyCreated.kind !== "missing") {
      user = concurrentlyCreated;
      if (legacy.kind !== "missing") {
        warnings.push(
          `Chrome DevTools legacy settings ignored: ${legacySettingsFilePath()} exists, but ${userPath} takes precedence. Delete ${LEGACY_SETTINGS_FILE_NAME} after confirming your settings.`,
        );
      }
    } else if (legacy.kind !== "missing") {
      user = legacy;
      if (legacy.kind === "valid") {
        warnings.push(
          `Using legacy ${LEGACY_SETTINGS_FILE_NAME}; rename it to ${NEW_SETTINGS_FILE_NAME}. Future saves write ${NEW_SETTINGS_FILE_NAME} without modifying the legacy file.`,
        );
      }
    }
  }
  warnings.push(...user.warnings);

  let project: SettingsDocumentResult = { kind: "missing", warnings: [] };
  if (projectPath && options.projectTrusted) {
    project = await readSettingsDocument(projectPath, "project", options.cwd);
    warnings.push(...project.warnings);
  }

  const environmentWarning = deprecatedEnvironmentWarning();
  if (environmentWarning) warnings.push(environmentWarning);

  const userBrowser = user.normalized?.browser ?? {};
  const effectiveBrowser = resolveEffectiveBrowser(userBrowser, project.normalized?.browser);
  const settings = resolveSettings(user.normalized, project.normalized, effectiveBrowser);
  const recognized =
    settings.tools !== undefined ||
    user.normalized?.browser !== undefined ||
    project.normalized?.browser !== undefined ||
    user.normalized?.webmcp !== undefined;
  const invalidReasons = [user, project]
    .filter((result) => result.kind === "invalid")
    .map((result) => result.reason)
    .filter((reason): reason is string => Boolean(reason));
  const userFile: UserSettingsFileStatus =
    user.kind === "invalid"
      ? {
          kind: "invalid",
          reason: user.reason ?? `${userPath}: invalid settings`,
        }
      : { kind: user.kind };
  const base = {
    effectiveBrowser,
    effectiveWebMcpEnabled: settings.webmcp.enabled,
    paths,
    userFile,
    warnings,
    ...(warnings.length > 0 ? { notice: warnings.join("\n") } : {}),
  };

  if (recognized) return { ...base, kind: "loaded", settings };
  if (invalidReasons.length > 0) {
    return { ...base, kind: "invalid", reason: invalidReasons.join("; ") };
  }
  return { ...base, kind: "missing" };
}

function resolveSettings(
  user: NormalizedSettingsDocument | undefined,
  _project: NormalizedSettingsDocument | undefined,
  browser: EffectiveBrowserSettings,
): ResolvedChromeDevToolsSettings {
  return {
    ...(user?.tools ? { tools: user.tools, updatedAt: user.updatedAt } : {}),
    browser,
    webmcp: { enabled: user?.webmcp?.enabled ?? false },
  };
}

function resolveEffectiveBrowser(
  user: UserBrowserSettings,
  project: UserBrowserSettings | undefined,
): EffectiveBrowserSettings {
  const configuredEndpoint = parseBrowserEndpoint(user.endpoint ?? DEFAULT_BROWSER_ENDPOINT);
  const environmentHost = process.env.PI_CHROME_DEVTOOLS_HOST;
  const environmentPortValue = process.env.PI_CHROME_DEVTOOLS_PORT;
  const environmentPort = parseConfiguredPort(environmentPortValue);
  const environmentEndpointConfigured = environmentHost !== undefined || environmentPort !== undefined;
  const host = environmentHost ?? configuredEndpoint.host;
  const port = environmentPort ?? configuredEndpoint.port;
  const environmentAutoLaunch = process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH;
  const environmentExecutable = process.env.PI_CHROME_DEVTOOLS_BROWSER;
  const executablePath = environmentExecutable || user.executablePath;
  const extensionPaths = project?.extensionPaths ?? user.extensionPaths ?? [];
  const endpointSource: BrowserSettingsSource = environmentEndpointConfigured
    ? "environment"
    : user.endpoint
      ? "user"
      : "default";
  return {
    endpoint: formatBrowserEndpoint(host, port),
    host,
    port,
    hostConfigured: environmentHost !== undefined || user.endpoint !== undefined,
    portConfigured: environmentPort !== undefined || user.endpoint !== undefined,
    autoLaunchEnabled: environmentAutoLaunch === undefined ? (user.autoLaunch ?? true) : environmentAutoLaunch !== "0",
    ...(executablePath ? { executablePath } : {}),
    extensionPaths: [...extensionPaths],
    endpointSource,
    autoLaunchSource:
      environmentAutoLaunch !== undefined ? "environment" : user.autoLaunch !== undefined ? "user" : "default",
    executablePathSource: environmentExecutable ? "environment" : user.executablePath ? "user" : "default",
    extensionPathsSource: project?.extensionPaths ? "project" : user.extensionPaths ? "user" : "default",
  };
}

function deprecatedEnvironmentWarning() {
  const configuredNames = [
    "PI_CHROME_DEVTOOLS_HOST",
    "PI_CHROME_DEVTOOLS_PORT",
    "PI_CHROME_DEVTOOLS_AUTO_LAUNCH",
    "PI_CHROME_DEVTOOLS_BROWSER",
  ].filter((name) => process.env[name] !== undefined);
  if (configuredNames.length === 0) return undefined;
  return `Chrome DevTools environment settings are deprecated and will be removed in a future version: ${configuredNames.join(", ")}. Move them to browser.endpoint, browser.autoLaunch, and browser.executablePath in ${settingsFilePath()}. Environment values remain active overrides during the deprecation period.`;
}

async function readSettingsDocument(
  filePath: string,
  scope: "project" | "user",
  cwd?: string,
): Promise<SettingsDocumentResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", warnings: [] };
    const reason = `${filePath}: ${formatError(error)}`;
    return { kind: "invalid", reason, warnings: [`Chrome DevTools settings ignored: ${reason}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const reason = `${filePath}: invalid JSON`;
    return { kind: "invalid", reason, warnings: [`Chrome DevTools settings ignored: ${reason}`] };
  }
  if (!isRecord(parsed)) {
    const reason = `${filePath}: expected a JSON object`;
    return { kind: "invalid", reason, warnings: [`Chrome DevTools settings ignored: ${reason}`] };
  }

  const scopeWarnings = projectOwnedSettingsWarnings(parsed, scope, filePath);
  try {
    const normalized = await normalizeSettingsDocument(parsed, scope, filePath, cwd);
    return { kind: "valid", document: { ...parsed }, normalized, warnings: scopeWarnings };
  } catch (error) {
    const reason = `${filePath}: ${formatError(error)}`;
    return {
      kind: "invalid",
      reason,
      warnings: [...scopeWarnings, `Chrome DevTools settings ignored: ${reason}`],
    };
  }
}

function projectOwnedSettingsWarnings(document: Record<string, unknown>, scope: "project" | "user", filePath: string) {
  if (scope !== "project") return [];
  const browser = isRecord(document.browser) ? document.browser : undefined;
  const warnings = browser
    ? ["endpoint", "autoLaunch", "executablePath"]
        .filter((field) => browser[field] !== undefined)
        .map(
          (field) =>
            `Chrome DevTools project browser.${field} ignored in ${filePath}; configure this machine-owned setting in ${settingsFilePath()}.`,
        )
    : [];
  if (document.webmcp !== undefined) {
    warnings.push(
      `Chrome DevTools project webmcp settings ignored in ${filePath}; only the user settings file may enable experimental WebMCP.`,
    );
  }
  return warnings;
}

async function normalizeSettingsDocument(
  document: Record<string, unknown>,
  scope: "project" | "user",
  filePath: string,
  cwd?: string,
): Promise<NormalizedSettingsDocument> {
  const normalized: NormalizedSettingsDocument = {};

  if (scope === "user" && (document.tools !== undefined || document.updatedAt !== undefined)) {
    const toolSettings = normalizeChromeDevtoolsSettings(document);
    if (!toolSettings) {
      throw new Error("expected tools to be an array of Chrome DevTools tool names with numeric updatedAt");
    }
    normalized.tools = toolSettings.tools;
    normalized.updatedAt = toolSettings.updatedAt;
  }

  if (document.browser !== undefined) {
    if (!isRecord(document.browser)) throw new Error("expected browser to be an object");
    normalized.browser = await normalizeBrowserSection(document.browser, scope, filePath, cwd);
  }

  if (scope === "user" && document.webmcp !== undefined) {
    if (!isRecord(document.webmcp) || typeof document.webmcp.enabled !== "boolean") {
      throw new Error("expected webmcp.enabled to be a boolean");
    }
    normalized.webmcp = { enabled: document.webmcp.enabled };
  }

  return normalized;
}

async function normalizeBrowserSection(
  browser: Record<string, unknown>,
  scope: "project" | "user",
  _filePath: string,
  cwd?: string,
): Promise<UserBrowserSettings> {
  const normalized: UserBrowserSettings = {};
  if (scope === "user" && browser.endpoint !== undefined) {
    if (typeof browser.endpoint !== "string") {
      throw new Error("expected browser.endpoint to be an HTTP URL with an explicit port");
    }
    normalized.endpoint = parseBrowserEndpoint(browser.endpoint).endpoint;
  }
  if (scope === "user" && browser.autoLaunch !== undefined) {
    if (typeof browser.autoLaunch !== "boolean") {
      throw new Error("expected browser.autoLaunch to be a boolean");
    }
    normalized.autoLaunch = browser.autoLaunch;
  }
  if (scope === "user" && browser.executablePath !== undefined) {
    if (typeof browser.executablePath !== "string" || browser.executablePath.length === 0) {
      throw new Error("expected browser.executablePath to be a non-empty absolute path");
    }
    if (!isAbsolute(browser.executablePath)) {
      throw new Error("browser.executablePath in user settings must be absolute");
    }
    normalized.executablePath = resolve(browser.executablePath);
  }

  if (browser.extensionPaths !== undefined) {
    if (
      !Array.isArray(browser.extensionPaths) ||
      !browser.extensionPaths.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(`expected ${scope} browser.extensionPaths to be an array of non-empty paths`);
    }
    const resolvedPaths: string[] = [];
    for (const configuredPath of browser.extensionPaths as string[]) {
      if (scope === "user" && !isAbsolute(configuredPath)) {
        throw new Error("browser.extensionPaths in user settings must contain only absolute paths");
      }
      const absolutePath = isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(cwd ?? process.cwd(), configuredPath);
      resolvedPaths.push(await validateUnpackedExtensionPath(absolutePath));
    }
    normalized.extensionPaths = orderedUnique(resolvedPaths);
  }
  return normalized;
}

async function validateUnpackedExtensionPath(extensionPath: string) {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(extensionPath);
    const extensionStat = await stat(canonicalPath);
    if (!extensionStat.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new Error(`unpacked extension path ${extensionPath} is invalid: ${formatError(error)}`);
  }

  const manifestPath = join(canonicalPath, "manifest.json");
  let manifest: unknown;
  try {
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile()) throw new Error("not a regular file");
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`unpacked extension ${canonicalPath} has invalid manifest.json: ${formatError(error)}`);
  }
  if (canonicalPath.includes(",")) {
    throw new Error(
      `unpacked extension path ${canonicalPath} cannot contain a comma because Chrome separates multiple --load-extension paths with commas`,
    );
  }
  if (
    !isRecord(manifest) ||
    ![2, 3].includes(manifest.manifest_version as number) ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      `unpacked extension ${canonicalPath} has invalid manifest.json: expected manifest_version, name, and version`,
    );
  }
  return canonicalPath;
}

export function parseBrowserEndpoint(value: string) {
  const trimmedValue = value.trim();
  const explicitPort = trimmedValue.match(/^http:\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)\/?$/i)?.[1];
  let endpoint: URL;
  try {
    endpoint = new URL(trimmedValue);
  } catch {
    throw new Error("browser.endpoint must be a valid HTTP URL with an explicit port");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    !endpoint.hostname ||
    !explicitPort ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "browser.endpoint must be an HTTP origin with an explicit port and no credentials, path, query, or fragment",
    );
  }
  const port = parseConfiguredPort(explicitPort);
  if (port === undefined) {
    throw new Error("browser.endpoint must use a port from 1 through 65535");
  }
  const host = endpoint.hostname;
  return { endpoint: formatBrowserEndpoint(host, port), host, port };
}

export function parseConfiguredPort(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) return undefined;
  const port = Number(trimmedValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return port;
}

function formatBrowserEndpoint(host: string, port: number) {
  const formattedHost = host.startsWith("[") && host.endsWith("]") ? host : host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

export function normalizeChromeDevtoolsSettings(value: unknown): ChromeDevToolsSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;

  if (value.tools === "enabled") {
    return { tools: [...CHROME_DEVTOOLS_TOOL_NAMES], updatedAt: value.updatedAt };
  }
  if (value.tools === "disabled") return { tools: [], updatedAt: value.updatedAt };
  if (!Array.isArray(value.tools) || !value.tools.every(isChromeDevtoolsToolName)) return undefined;
  return { tools: orderedUniqueChromeDevtoolsTools(value.tools), updatedAt: value.updatedAt };
}

function isChromeDevtoolsToolName(value: unknown): value is ChromeDevToolsToolName {
  return typeof value === "string" && CHROME_DEVTOOLS_TOOL_NAMES.includes(value as never);
}

function orderedUniqueChromeDevtoolsTools(tools: readonly ChromeDevToolsToolName[]) {
  const selectedTools = new Set(tools);
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function orderedUnique(values: readonly string[]) {
  return [...new Set(values)];
}

export function saveSettings(
  settings: ChromeDevToolsSettings,
  operations: Partial<SettingsFileOperations> = {},
): Promise<void> {
  return queueSettingsMutation(
    (current) => ({
      ...current,
      tools: [...settings.tools],
      updatedAt: settings.updatedAt,
    }),
    operations,
  );
}

export function saveWebMcpSettings(enabled: boolean, operations: Partial<SettingsFileOperations> = {}): Promise<void> {
  return queueSettingsMutation(
    (current) => ({
      ...current,
      webmcp: {
        ...(isRecord(current.webmcp) ? current.webmcp : {}),
        enabled,
      },
    }),
    operations,
  );
}

export function saveBrowserSettings(
  patch: BrowserSettingsPatch,
  operations: Partial<SettingsFileOperations> = {},
): Promise<void> {
  return queueSettingsMutation(async (current) => {
    const browser = isRecord(current.browser) ? { ...current.browser } : {};
    for (const field of ["endpoint", "autoLaunch", "executablePath"] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) delete browser[field];
      else browser[field] = value;
    }
    await normalizeBrowserSection(browser, "user", settingsFilePath());
    return { ...current, browser };
  }, operations);
}

function queueSettingsMutation(
  mutate: (current: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  operations: Partial<SettingsFileOperations>,
) {
  const operation = settingsSaveQueue.then(() => saveSettingsMutationNow(mutate, operations));
  settingsSaveQueue = operation.catch(() => undefined);
  return operation;
}

async function saveSettingsMutationNow(
  mutate: (current: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  operations: Partial<SettingsFileOperations>,
): Promise<void> {
  const filePath = settingsFilePath();
  let current = await readSettingsDocument(filePath, "user");
  const replaceCanonical = current.kind !== "missing";
  if (!replaceCanonical) current = await readSettingsDocument(legacySettingsFilePath(), "user");
  if (current.kind === "invalid") {
    throw new Error(`Cannot save Chrome DevTools settings until you repair ${current.reason}`);
  }
  const nextDocument = await mutate(current.document ?? {});
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(tempFile, `${JSON.stringify(nextDocument, null, 2)}\n`);
    if (!replaceCanonical && (await pathEntryExists(filePath))) {
      throw new Error(`${NEW_SETTINGS_FILE_NAME} was created concurrently; reopen settings and retry.`);
    }
    await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(tempFile, filePath);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function settingsFilePath() {
  return join(getAgentDir(), NEW_SETTINGS_FILE_NAME);
}

export function projectSettingsFilePath(cwd: string) {
  return join(cwd, CONFIG_DIR_NAME, NEW_SETTINGS_FILE_NAME);
}

function legacySettingsFilePath() {
  return join(getAgentDir(), LEGACY_SETTINGS_FILE_NAME);
}

async function fileExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
