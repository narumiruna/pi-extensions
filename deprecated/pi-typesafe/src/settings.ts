import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE_NAME = "pi-typesafe.json";

export interface TypeSafeSettings {
  openRouterFallback: boolean;
}

export interface LoadedTypeSafeSettings {
  settings: TypeSafeSettings;
  warning?: string;
}

export const DEFAULT_TYPESAFE_SETTINGS: Readonly<TypeSafeSettings> = {
  openRouterFallback: false,
};

export function settingsFilePath(agentDir = getAgentDir()): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

export async function loadSettings(path = settingsFilePath()): Promise<LoadedTypeSafeSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { settings: { ...DEFAULT_TYPESAFE_SETTINGS } };
    }
    return invalidSettings(path, `could not be read: ${formatError(error)}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return invalidSettings(path, "must contain valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return invalidSettings(path, "must be a JSON object");
  }

  const settingsDocument = document as Record<string, unknown>;
  const openRouterFallback = Object.hasOwn(settingsDocument, "openRouterFallback")
    ? settingsDocument.openRouterFallback
    : undefined;
  if (openRouterFallback !== undefined && typeof openRouterFallback !== "boolean") {
    return invalidSettings(path, 'field "openRouterFallback" must be a boolean');
  }

  return {
    settings: {
      openRouterFallback: openRouterFallback ?? DEFAULT_TYPESAFE_SETTINGS.openRouterFallback,
    },
  };
}

function invalidSettings(path: string, reason: string): LoadedTypeSafeSettings {
  return {
    settings: { ...DEFAULT_TYPESAFE_SETTINGS },
    warning: `pi-typesafe settings at ${path} ${reason}; using defaults without changing ${SETTINGS_FILE_NAME}.`,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
