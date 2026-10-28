import { isAbsolute, posix } from "node:path";

export function validateDatabasePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("AgentFS requires a nonempty absolute database path.");
  }
}

/** Virtual paths never use the host cwd or home directory. */
export function virtualPath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Invalid virtual path.");
  if (path === "~") return "/";
  if (path.startsWith("~/")) path = path.slice(2);
  else if (path.startsWith("~")) throw new Error("Named home directories are not supported.");
  return posix.resolve("/", path);
}
