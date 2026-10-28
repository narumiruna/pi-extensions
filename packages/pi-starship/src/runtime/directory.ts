import { isAbsolute } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

const PATH_VARIABLES = ["path", "full_path", "before_root_path", "repo_root"] as const;

/** Collect only requested metadata. Rendering and previews consume this cache. */
export async function collectDirectory(context: CollectorContext): Promise<MutableModuleSnapshot> {
  const { input } = context;
  if (input.signal?.aborted || !context.needs("directory")) return {};
  const options = context.options("directory");
  const needsPhysicalPath =
    options.use_logical_path === false && PATH_VARIABLES.some((name) => context.needs("directory", name));
  const needsPermission =
    context.needs("directory", "read_only") &&
    typeof options.read_only === "string" &&
    sanitizeTerminalText(options.read_only).length > 0;
  if (!needsPhysicalPath && !needsPermission) return {};
  const values: Record<string, string> = {};
  if (needsPhysicalPath) {
    const path = await context.fs.realPath?.(input.cwd).catch(() => undefined);
    if (input.signal?.aborted) return {};
    if (typeof path === "string" && isAbsolute(path)) values.physical_path = path;
  }
  if (needsPermission) {
    // fs access follows symlinks, so a permission-only format does not need a
    // physical-path probe. Unknown permissions do not imply read-only status.
    const writable = await context.fs.isWritable?.(input.cwd).catch(() => undefined);
    if (input.signal?.aborted) return {};
    if (typeof writable === "boolean") values.read_only = writable ? "false" : "true";
  }
  return Object.keys(values).length > 0 ? { directory: values } : {};
}
