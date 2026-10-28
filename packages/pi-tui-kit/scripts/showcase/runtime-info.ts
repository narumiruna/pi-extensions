import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_EXTENSION_MENU_API_VERSION, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";

export interface ShowcaseRuntimeInfo {
  version: string;
  apiVersion: number;
  origin: string;
}

/** Resolve and compare the actual loaded implementation, not an installed version hint. */
export async function inspectShowcaseRuntime(): Promise<ShowcaseRuntimeInfo> {
  const origin = realpathSync(fileURLToPath(import.meta.resolve("@narumitw/pi-tui-kit")));
  const loaded = await import(pathToFileURL(origin).href);
  if (loaded.runMenu !== runMenu || loaded.PI_EXTENSION_MENU_API_VERSION !== PI_EXTENSION_MENU_API_VERSION) {
    throw new Error("Showcase Kit module identity does not match its resolved origin.");
  }
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(origin), "../package.json"), "utf8"));
  if (manifest.name !== "@narumitw/pi-tui-kit" || typeof manifest.version !== "string") {
    throw new Error("Showcase Kit manifest is invalid.");
  }
  return {
    version: sanitizeTerminalText(manifest.version),
    apiVersion: PI_EXTENSION_MENU_API_VERSION,
    origin: sanitizeTerminalText(origin),
  };
}

export function runtimeInfoLines(info: ShowcaseRuntimeInfo | undefined): string[] {
  return info
    ? [`Kit version: ${info.version}`, `Kit API version: ${info.apiVersion}`, `Built module origin: ${info.origin}`]
    : ["Runtime information is available when launched through the showcase runtime."];
}
