import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const lazyInputs = [
  "src/files-menu.ts",
  "src/file-context-explorer.ts",
  "src/file-context-menu.ts",
  "src/scope/menu.ts",
  "src/scope/picker.ts",
  "src/scope/ui.ts",
];

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-files",
  forbiddenEagerInputs: lazyInputs,
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: ["@narumitw/pi-tui-kit/editor-status-widget", "@narumitw/pi-tui-kit/terminal-text"],
});

test("merged runtime keeps scope enforcement eager and both specialized workflows lazy", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-files-build-test-"));
  try {
    const metadata = await builder.buildRuntime({ outputDirectory: join(root, "dist") });
    const { eagerInputs } = builder.validateEagerGraph(metadata);
    const allInputs = new Set(
      Object.values(metadata.outputs ?? {}).flatMap((output) =>
        Object.keys(output.inputs ?? {}).map((input) => input.replaceAll("\\", "/")),
      ),
    );
    for (const input of [
      "src/files.ts",
      "src/context-service.ts",
      "src/file-context.ts",
      "src/scope/edit-scope.ts",
      "src/scope/policy.ts",
      "src/scope/paths.ts",
      "src/scope/state.ts",
      "src/scope/contracts.ts",
    ]) {
      assert.ok(
        [...eagerInputs].some((path) => path.endsWith(`/${input}`)),
        `${input} must load before tools run`,
      );
    }
    for (const input of lazyInputs) {
      assert.ok(
        [...allInputs].some((path) => path === input || path.endsWith(`/${input}`)),
        `${input} is missing`,
      );
      assert.equal(
        [...eagerInputs].some((path) => path.endsWith(`/${input}`)),
        false,
        input,
      );
    }
    assert.equal(
      [...allInputs].some((input) => /(?:deprecated|pi-file-context|pi-edit-scope)\//u.test(input)),
      false,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
