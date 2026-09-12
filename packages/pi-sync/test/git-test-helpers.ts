import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedGitBackend } from "../src/backends/backend-types.js";

export function gitConfig(remote: string): ResolvedGitBackend {
  return {
    type: "git",
    profile: { kind: "git", remote },
    destination: { branch: "pi-sync/default", directory: "pi-sync", namespace: "default" },
  };
}

export function createBareRemote() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-git-"));
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  return { root, remote };
}
