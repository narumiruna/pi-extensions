import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
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
  run(npmCommand, ["exec", "--", "npm-check-updates", "--workspaces", "--root", "-u"]);
  run(npmCommand, ["install", "--package-lock-only", "--ignore-scripts"]);
}

function verifyUpdate() {
  run(npmCommand, ["ci"]);
  run(npmCommand, ["--workspaces", "--if-present", "run", "build:web"]);
  run(npmCommand, ["run", "check"]);
  run(npmCommand, ["test"]);
  run(npmCommand, ["pack", "--workspaces", "--dry-run"]);
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
