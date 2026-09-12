import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { PiInvocationError, resolvePiInvocation } from "../src/pi-invocation.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp("/tmp/pi-fleet-invocation-test-");
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createCorePackage(root: string): Promise<string> {
  const packageDirectory = join(root, "core package");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
  );
  await writeFile(join(packageDirectory, "dist/cli.js"), "console.log('pi');\n");
  return packageDirectory;
}

test("Pi invocation resolves Node and Bun package entrypoints without PATH lookup", async () => {
  await fixture(async (root) => {
    const packageDirectory = await createCorePackage(root);
    const realPackageDirectory = await realpath(packageDirectory);
    assert.deepEqual(
      resolvePiInvocation(["--name", "child"], {
        execPath: "/runtime path/node",
        packageDir: packageDirectory,
        runtimeKind: "node",
      }),
      {
        command: "/runtime path/node",
        args: [join(realPackageDirectory, "dist/cli.js"), "--name", "child"],
      },
    );
    assert.deepEqual(
      resolvePiInvocation([], {
        execPath: "/runtime path/bun",
        packageDir: packageDirectory,
        runtimeKind: "bun",
      }),
      { command: "/runtime path/bun", args: [join(realPackageDirectory, "dist/cli.js")] },
    );
  });
});

test("Pi invocation accepts a standalone executable only inside its package", async () => {
  await fixture(async (root) => {
    const packageDirectory = await createCorePackage(root);
    const standalone = join(packageDirectory, "pi");
    await writeFile(standalone, "#!/bin/sh\nexit 0\n");
    await chmod(standalone, 0o700);
    const realStandalone = await realpath(standalone);
    assert.deepEqual(
      resolvePiInvocation(["--name", "child"], {
        execPath: standalone,
        packageDir: packageDirectory,
        runtimeKind: "bun",
      }),
      { command: realStandalone, args: ["--name", "child"] },
    );
  });
});

test("Pi invocation fails closed for missing, escaping, or unsupported runtimes", async () => {
  await fixture(async (root) => {
    const packageDirectory = await createCorePackage(root);
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../escape.js" } }),
    );
    assert.throws(
      () =>
        resolvePiInvocation([], {
          execPath: "/node",
          packageDir: packageDirectory,
          runtimeKind: "node",
        }),
      PiInvocationError,
    );
    assert.throws(
      () =>
        resolvePiInvocation([], {
          execPath: "/other",
          packageDir: join(root, "missing"),
          runtimeKind: "unsupported",
        }),
      PiInvocationError,
    );
  });
});
