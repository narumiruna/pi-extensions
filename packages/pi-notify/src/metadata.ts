import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { BodyEmphasis, Notification } from "./provider.js";
import { clipText } from "./text.js";

export interface Metadata {
  id: string;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  startedAt: number;
  settledAt: number;
  error: boolean;
}
export const safeText = (value: string) => clipText(sanitizeTerminalText(value).replaceAll("@", "＠"), 400);
export function displayPath(raw: string): string {
  const path = safeText(raw);
  const home = safeText(homedir());
  return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
function git(cwd: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", ...args],
      { signal, timeout: 1500, maxBuffer: 8192, encoding: "utf8", windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}
export async function notificationMetadata(data: Metadata, signal: AbortSignal): Promise<Notification> {
  const [root, common, branch] = await Promise.all([
    git(data.cwd, ["--show-toplevel"], signal),
    git(data.cwd, ["--git-common-dir"], signal),
    git(data.cwd, ["--abbrev-ref", "HEAD"], signal),
  ]);
  signal.throwIfAborted();
  const detached = branch === "HEAD" ? await git(data.cwd, ["--short", "HEAD"], signal) : undefined;
  signal.throwIfAborted();
  let body = "";
  const bodyEmphasis: BodyEmphasis[] = [];
  const line = (label: string, value: string, style?: BodyEmphasis["style"], prefix = "", suffix = "") => {
    if (body) body += "\n";
    body += `${label}: ${prefix}`;
    if (style && value.length) bodyEmphasis.push({ style, offset: body.length, length: value.length });
    body += value + suffix;
  };
  line("Computer", safeText(hostname()));
  line(
    "Session",
    safeText(data.sessionId),
    "monospace",
    `${data.sessionName ? `${safeText(data.sessionName)} ` : ""}(`,
    ")",
  );
  line("Workspace", displayPath(data.cwd), "monospace");
  if (root) {
    // Sanitize before splitting paths. Common Git directory names identify linked worktrees.
    const cleanRoot = safeText(root);
    const cleanCommon = common ? safeText(common) : undefined;
    const commonDirectory = cleanCommon && isAbsolute(cleanCommon) ? cleanCommon : undefined;
    const repository =
      commonDirectory && basename(commonDirectory) === ".git"
        ? basename(dirname(commonDirectory))
        : basename(cleanRoot);
    line("Repository", repository, "bold");
    line("Worktree", displayPath(root), "monospace");
    if (branch) line("Branch", safeText(branch === "HEAD" ? `detached ${detached ?? "HEAD"}` : branch), "monospace");
  }
  line("Elapsed", `${Math.max(0, Math.floor((data.settledAt - data.startedAt) / 1000))}s`);
  line("Stopped", new Date(data.settledAt).toISOString());
  return {
    id: data.id,
    title: data.error ? "Pi stopped with an error" : "Pi is ready for review",
    body,
    bodyEmphasis,
    settledAt: data.settledAt,
  };
}
