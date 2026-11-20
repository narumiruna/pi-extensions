import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ExternalPreviewRoot, relativePreviewPath } from "./filelinks.js";

type PreviewSettings = { roots: readonly ExternalPreviewRoot[]; invalid?: true };

export async function loadPreviewSettings(signal: AbortSignal): Promise<PreviewSettings> {
  const defaults = { roots: [] };
  const invalid = { ...defaults, invalid: true } as const;
  try {
    const file = join(getAgentDir(), "pi-inline.json");
    // Settings are a regular user file, not a project file, symlink, or stream.
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!stat || signal.aborted) return defaults;
    if (!stat.isFile()) return invalid;
    const source = await readFile(file, { encoding: "utf8", signal });
    if (signal.aborted) return defaults;
    const document: unknown = JSON.parse(source);
    if (!document || typeof document !== "object" || Array.isArray(document)) return invalid;
    if (!("externalPreviewRoots" in document)) return defaults;
    const values = document.externalPreviewRoots;
    if (!Array.isArray(values)) return invalid;
    if (!values.length || signal.aborted) return defaults;

    const home = resolve(homedir());
    const realHome = await realpath(home).catch(() => home);
    const roots: ExternalPreviewRoot[] = [];
    for (const value of values) {
      if (signal.aborted) return defaults;
      if (
        typeof value !== "string" ||
        !isAbsolute(value) ||
        /[*?[\]{}\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(value)
      ) {
        return invalid;
      }
      const path = resolve(value);
      if ([parse(path).root, home, realHome].includes(path) || relativePreviewPath(path, realHome)) return invalid;
      const identity = await lstat(path, { bigint: true });
      if (signal.aborted) return defaults;
      if (!identity.isDirectory() || (await realpath(path)) !== path) return invalid;
      roots.push({ path, identity });
    }
    return signal.aborted ? defaults : { roots };
  } catch {
    return signal.aborted ? defaults : invalid;
  }
}
