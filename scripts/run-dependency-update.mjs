import { spawnSync } from "node:child_process";
import { npmInvocation } from "./npm-invocation.mjs";

function runNpm(args) {
  const result = spawnSync(...npmInvocation(args), { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requireCleanWorktree() {
  const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (result.stdout.trim() !== "") {
    console.error("dependency updates require a clean worktree");
    process.exit(2);
  }
}

function updateLock() {
  requireCleanWorktree();
  runNpm(["exec", "--", "npm-check-updates", "--workspaces", "--root", "-u"]);
  runNpm(["install", "--package-lock-only", "--ignore-scripts"]);
}

function verifyUpdate() {
  runNpm(["ci"]);
  runNpm(["--workspaces", "--if-present", "run", "build:web"]);
  runNpm(["run", "check"]);
  runNpm(["test"]);
  runNpm(["pack", "--workspaces", "--dry-run"]);
}

function printUsage() {
  console.log("Usage: node scripts/run-dependency-update.mjs <lock|verify|all>");
}

const [mode, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length > 0) {
  printUsage();
  process.exit(2);
}
if (mode === "--help" || mode === "-h") {
  printUsage();
} else if (mode === "lock") {
  updateLock();
} else if (mode === "verify") {
  verifyUpdate();
} else if (mode === "all") {
  updateLock();
  verifyUpdate();
} else {
  printUsage();
  process.exit(2);
}
