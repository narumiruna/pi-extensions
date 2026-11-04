import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

for (const failure of [undefined, "kit", "assets", "hooks"]) {
  test(`root production prepare ${failure ? `stops at ${failure} failure` : "orders Kit, assets, then hooks"}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pi-prepare-"));
    try {
      for (const subdir of ["scripts", "packages/pi-inspect/scripts", ".husky"])
        mkdirSync(path.join(directory, subdir), { recursive: true });
      copyFileSync(path.resolve("scripts/prepare.mjs"), path.join(directory, "scripts/prepare.mjs"));
      for (const [file, stage] of [
        ["scripts/prepare-kit-runtime.mjs", "kit"],
        ["packages/pi-inspect/scripts/build.mjs", "assets"],
        [".husky/install.mjs", "hooks"],
      ]) {
        const operation = `appendFileSync("order.txt", ${JSON.stringify(`${stage}\n`)}); ${stage === failure ? `throw new Error("${stage} failed");` : ""}`;
        writeFileSync(
          path.join(directory, file),
          `import { appendFileSync } from "node:fs"; ${stage === "kit" ? `export async function prepareKitRuntime() { ${operation} }` : operation}`,
        );
      }
      const result = spawnSync(process.execPath, ["scripts/prepare.mjs"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production" },
      });
      const stages = ["kit", "assets", "hooks"];
      const completed = failure ? stages.slice(0, stages.indexOf(failure) + 1) : stages;
      assert.equal(readFileSync(path.join(directory, "order.txt"), "utf8"), `${completed.join("\n")}\n`);
      if (failure) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`${failure} failed`, "u"));
      } else assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
