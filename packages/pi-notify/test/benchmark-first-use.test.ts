import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/benchmark-first-use.mjs", import.meta.url));
const posixTest = test.skipIf(process.platform === "win32");

for (const args of [[], ["package"], ["source"]]) {
  posixTest(`first-use benchmark resolves ${args[0] ?? "default"} from another working directory`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-notify-benchmark-test-"));
    try {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd,
        env: { ...process.env, PI_OFFLINE: "1" },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message || "Benchmark process failed");
      const measurement = JSON.parse(result.stdout.trim());
      const kind = args[0] ?? "package";
      assert.equal(measurement.name, "notify");
      assert.equal(measurement.kind, kind);
      assert.equal(measurement.entry, resolve(packageRoot, kind === "source" ? "src/index.ts" : "."));
      assert.equal(typeof measurement.firstUseMs, "number");
      assert.ok(Number.isFinite(measurement.firstUseMs) && measurement.firstUseMs >= 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const args of [["unknown"], ["source", "trailing"]]) {
  posixTest(`first-use benchmark rejects ${args.join(" ")}`, () => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected source or package, with no trailing arguments/u);
    assert.equal(result.stdout, "");
  });
}
