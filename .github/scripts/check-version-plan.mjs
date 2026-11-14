import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(path.join(tmpdir(), "pi-version-plan-"));
try {
  const planPath = path.join(directory, "release-plan.json");
  const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
  execFileSync(process.execPath, [cli, "status", "--output", planPath], { stdio: "inherit" });
  const { releases } = JSON.parse(readFileSync(planPath, "utf8"));
  const hasReleases = releases.some(({ oldVersion, newVersion }) => oldVersion !== newVersion);
  appendFileSync(process.env.GITHUB_OUTPUT, `has-releases=${hasReleases}\n`);
  if (!hasReleases) console.log("No package versions would change; skipping the version pull request.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
