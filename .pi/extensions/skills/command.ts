import { parseRepository } from "./github.ts";

export interface Route {
  kind: "main" | "add" | "remove" | "move";
  repository?: string;
}

export function parseCommand(args: string): Route {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  if (parts.length === 0) return { kind: "main" };
  const [kind, repository] = parts;
  if (kind === "add" && parts.length <= 2) {
    return { kind, ...(repository ? { repository: parseRepository(repository) } : {}) };
  }
  if ((kind === "remove" || kind === "move") && parts.length === 1) return { kind };
  throw new Error("Usage: /skills [add [owner/repo] | remove | move]");
}

export function argumentCompletions(prefix: string) {
  if (/\s/.test(prefix.trimStart())) return null;
  return ["add", "remove", "move"]
    .filter((value) => value.startsWith(prefix.trimStart()))
    .map((value) => ({ value, label: value }));
}
