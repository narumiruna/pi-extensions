import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { normalizeOtlpConnection, type OtlpConnection } from "./otlp-settings.js";
import { DEFAULT_BASE_URL } from "./runtime-defaults.js";

export { DEFAULT_BASE_URL } from "./runtime-defaults.js";

const CONFIG_FILE_NAME = "pi-otel.json";
const LEGACY_CONFIG_FILE_NAME = "pi-langfuse.json";

export interface LangfuseConfig {
  backend?: "langfuse";
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
  userId?: string;
  captureContent: boolean;
}

export type LangfuseConfigPatch = Partial<LangfuseConfig>;

interface OtlpSettings extends OtlpConnection {
  backend: "otlp";
  captureContent: boolean;
  userId?: string;
}

export type TracingSettings = LangfuseConfig | OtlpSettings;
type NormalizedSettings<T> = { ok: true; config: T } | { ok: false; reason: string };
export type SettingsResult = NormalizedSettings<TracingSettings> & {
  path: string;
  warnings: string[];
  missing?: true;
  legacy?: true;
};

export function otelSettingsPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

const configSaveQueues = new Map<string, Promise<void>>();

export function writeLangfuseConfig(patch: LangfuseConfigPatch, path = otelSettingsPath()): Promise<LangfuseConfig> {
  const previous = configSaveQueues.get(path) ?? Promise.resolve();
  const operation = previous.then(() => writeLangfuseConfigNow(patch, path));
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  configSaveQueues.set(path, tail);
  void tail.then(() => {
    if (configSaveQueues.get(path) === tail) configSaveQueues.delete(path);
  });
  return operation;
}

async function writeLangfuseConfigNow(patch: LangfuseConfigPatch, path: string): Promise<LangfuseConfig> {
  const currentDocument = await readLangfuseDocumentForUpdate(path);
  const normalized = normalizeLangfuseConfig({ ...currentDocument, ...patch });
  if (!normalized.ok) throw new Error(normalized.reason);
  const {
    publicKey: _publicKey,
    secretKey: _secretKey,
    baseUrl: _baseUrl,
    environment: _environment,
    release: _release,
    userId: _userId,
    captureContent: _captureContent,
    ...unknownFields
  } = currentDocument;
  const nextDocument = { ...unknownFields, ...normalized.config };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    return normalized.config;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readLangfuseDocumentForUpdate(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(
      `Cannot update ${CONFIG_FILE_NAME} because the existing file is malformed or unreadable; repair it first.`,
    );
  }
  const normalized = normalizeLangfuseConfig(parsed);
  if (!normalized.ok) {
    throw new Error(
      `Cannot update ${CONFIG_FILE_NAME} because the existing file has invalid recognized fields; repair it first.`,
    );
  }
  return { ...(parsed as Record<string, unknown>) };
}

export async function loadSettings(path = otelSettingsPath()): Promise<SettingsResult> {
  const current = await readSettings(path, normalizeSettings);
  if (!current.missing || path !== otelSettingsPath()) return current;

  // Read legacy Langfuse credentials without creating or replacing the canonical file.
  const legacy = await readSettings(join(dirname(path), LEGACY_CONFIG_FILE_NAME), normalizeLangfuseConfig);
  // A concurrent setup can create the canonical file while the legacy read is in flight.
  const latest = await readSettings(path, normalizeSettings);
  return latest.missing && !legacy.missing ? { ...legacy, legacy: true } : latest;
}

async function readSettings(
  path: string,
  normalize: (value: unknown) => NormalizedSettings<TracingSettings>,
): Promise<SettingsResult> {
  await configSaveQueues.get(path);
  const warnings: string[] = [];
  const permissionFailure = await ensurePrivatePermissions(path, warnings);
  if (permissionFailure) {
    return {
      ok: false,
      path,
      warnings,
      reason: `Refusing to load credentials: ${permissionFailure}`,
    };
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: false, path, warnings, missing: true, reason: `Configuration file not found: ${path}` };
    }
    return {
      ok: false,
      path,
      warnings,
      reason: `Failed to read ${path}: ${formatError(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      path,
      warnings,
      reason: `Failed to parse ${path} as JSON; repair the file before retrying.`,
    };
  }

  const normalized = normalize(parsed);
  if (!normalized.ok) return { ok: false, path, warnings, reason: normalized.reason };
  return { ok: true, config: normalized.config, path, warnings };
}

function normalizeSettings(value: unknown): NormalizedSettings<TracingSettings> {
  if (!isSettingsObject(value) || value.backend !== "otlp") return normalizeLangfuseConfig(value);
  if (value.publicKey !== undefined || value.secretKey !== undefined || value.baseUrl !== undefined) {
    return { ok: false, reason: "OTLP settings cannot contain Langfuse credentials or a Langfuse baseUrl." };
  }
  const common = normalizeCommonSettings(value, false);
  if (!common.ok) return common;
  try {
    return { ok: true, config: { backend: "otlp", ...normalizeOtlpConnection(value), ...common.config } };
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  }
}

export function normalizeLangfuseConfig(value: unknown): NormalizedSettings<LangfuseConfig> {
  if (!isSettingsObject(value)) {
    return { ok: false, reason: `${CONFIG_FILE_NAME} must contain a JSON object.` };
  }
  const input = value;
  if (input.backend !== undefined && input.backend !== "langfuse") {
    return { ok: false, reason: 'Expected a Langfuse configuration with backend "langfuse" or no backend.' };
  }
  const publicKey = normalizeString(input.publicKey);
  const secretKey = normalizeString(input.secretKey);
  if (!publicKey) {
    return { ok: false, reason: "Langfuse settings require a literal publicKey string." };
  }
  if (!secretKey) {
    return { ok: false, reason: "Langfuse settings require a literal secretKey string." };
  }
  if (isInterpolation(publicKey)) {
    return {
      ok: false,
      reason: "Langfuse publicKey must be literal; environment and command interpolation are not supported.",
    };
  }
  if (isInterpolation(secretKey)) {
    return {
      ok: false,
      reason: "Langfuse secretKey must be literal; environment and command interpolation are not supported.",
    };
  }

  const rawBaseUrl = input.baseUrl === undefined ? DEFAULT_BASE_URL : normalizeString(input.baseUrl);
  if (!rawBaseUrl) {
    return { ok: false, reason: "Langfuse baseUrl must be a non-empty string." };
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      reason: "Langfuse baseUrl must use HTTP or HTTPS without credentials, a query, or a fragment.",
    };
  }

  const common = normalizeCommonSettings(input, true);
  if (!common.ok) return common;
  const environment = optionalString(input.environment, "environment");
  if (!environment.ok) return environment;
  if (environment.value && (environment.value.length > 40 || !/^(?!langfuse)[a-z0-9_-]+$/u.test(environment.value))) {
    return {
      ok: false,
      reason:
        "Langfuse environment must be at most 40 lowercase letters, numbers, hyphens, or underscores and must not start with langfuse.",
    };
  }
  const release = optionalString(input.release, "release");
  if (!release.ok) return release;

  return {
    ok: true,
    config: {
      publicKey,
      secretKey,
      baseUrl,
      ...(environment.value ? { environment: environment.value } : {}),
      ...(release.value ? { release: release.value } : {}),
      ...common.config,
    },
  };
}

function normalizeCommonSettings(
  input: Record<string, unknown>,
  captureByDefault: boolean,
): NormalizedSettings<Pick<TracingSettings, "userId" | "captureContent">> {
  if (input.captureContent !== undefined && typeof input.captureContent !== "boolean") {
    return { ok: false, reason: "captureContent must be a boolean." };
  }
  const userId = optionalString(input.userId, "userId");
  if (!userId.ok) return userId;
  if (userId.value && userId.value.length > 200) {
    return { ok: false, reason: "userId must be at most 200 characters." };
  }
  return {
    ok: true,
    config: {
      captureContent: input.captureContent ?? captureByDefault,
      ...(userId.value ? { userId: userId.value } : {}),
    },
  };
}

function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function ensurePrivatePermissions(path: string, warnings: string[]): Promise<string | undefined> {
  try {
    const file = await stat(path);
    if ((file.mode & 0o777) !== 0o600) {
      await chmod(path, 0o600);
      const repaired = await stat(path);
      if ((repaired.mode & 0o777) !== 0o600) {
        throw new Error(`permissions remained ${(repaired.mode & 0o777).toString(8)}`);
      }
      warnings.push(`Restricted ${path} permissions to 0600.`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    const failure = `Failed to enforce 0600 permissions for ${path}: ${formatError(error)}`;
    warnings.push(failure);
    return failure;
  }
  return undefined;
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown, name: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  const normalized = normalizeString(value);
  return normalized ? { ok: true, value: normalized } : { ok: false, reason: `${name} must be a non-empty string.` };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isInterpolation(value: string): boolean {
  return value.startsWith("$") || value.startsWith("!");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
