import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
interface BuildOptions {
  outputDirectory?: string;
  validateOutput?: (staging: string) => Promise<void>;
  renamePath?: typeof rename;
}
// The production module builds on import for prepare. Import a checkout-local copy,
// never a canonical writer beside concurrently running asset readers.
const { root, builderUrl, canonicalAssets, buildBrowserAssets, publishBrowserAssets } = await (async () => {
  const root = `${await mkdtemp(join(packageRoot, ".inspect-browser-build-test-module-"))}/`;
  try {
    await mkdir(join(root, "scripts"));
    await cp(new URL("../scripts/build.mjs", import.meta.url), join(root, "scripts/build.mjs"));
    await cp(join(packageRoot, "src"), join(root, "src"), { recursive: true });
    const canonicalAssets = await inventory(join(packageRoot, "browser-dist"));
    const builderUrl = pathToFileURL(join(root, "scripts/build.mjs")).href;
    const builder = (await import(builderUrl)) as {
      buildBrowserAssets(options?: BuildOptions): Promise<void>;
      publishBrowserAssets(staging: string, output: string, options?: Pick<BuildOptions, "renamePath">): Promise<void>;
    };
    return { root, builderUrl, canonicalAssets, ...builder };
  } catch (error) {
    // Vitest does not run suite hooks when top-level module evaluation fails.
    await rm(root, { recursive: true, force: true });
    throw error;
  }
})();
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const html = '<link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>';

async function assets(directory: string, label: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.html"), html);
  await writeFile(join(directory, "app.js"), `console.log(${JSON.stringify(label)});`);
  await writeFile(join(directory, "app.css"), `/* ${label} */ body { color: red; }`);
}

async function inventory(directory: string) {
  const result: Record<string, string> = {};
  for (const file of (await readdir(directory)).sort()) {
    result[file] = createHash("sha256")
      .update(await readFile(join(directory, file)))
      .digest("hex");
  }
  return result;
}

async function fixture(run: (output: string, staging: string) => Promise<void>) {
  const output = await mkdtemp(join(root, ".inspect-browser-build-test-"));
  const staging = await mkdtemp(join(root, ".inspect-browser-staging-"));
  try {
    await assets(output, "previous");
    await assets(staging, "next");
    await run(output, staging);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    // Retained recovery backups are asserted by the restoration test before cleanup.
    for (const file of await readdir(root)) {
      if (file.startsWith(`${output.slice(root.length)}.backup-`)) {
        await rm(join(root, file), { recursive: true, force: true });
      }
    }
  }
}

test("importing the isolated builder leaves canonical browser assets unchanged", async () => {
  assert.deepEqual(await inventory(join(packageRoot, "browser-dist")), canonicalAssets);
});

test("real browser builds are deterministic, use unique staging, and remove stale output", async () => {
  await fixture(async (output) => {
    const stages = new Set<string>();
    const options = {
      outputDirectory: output,
      validateOutput: async (staging: string) => {
        stages.add(staging);
      },
    };
    await buildBrowserAssets(options);
    const first = await inventory(output);
    assert.deepEqual(Object.keys(first), ["app.css", "app.js", "index.html"]);
    await writeFile(join(output, "stale.js"), "stale");
    await buildBrowserAssets(options);
    assert.deepEqual(await inventory(output), first);
    assert.equal(stages.size, 2);
    for (const staging of stages) await assert.rejects(readdir(staging), { code: "ENOENT" });
  });
});

for (const file of ["index.html", "app.js", "app.css"]) {
  for (const damage of ["missing", "empty", "symlink"] as const) {
    test(`publication rejects ${damage} ${file} without replacing complete output`, async () => {
      await fixture(async (output, staging) => {
        const previous = await inventory(output);
        await rm(join(staging, file));
        if (damage === "empty") await writeFile(join(staging, file), "");
        if (damage === "symlink") await symlink(join(output, file), join(staging, file));
        await assert.rejects(publishBrowserAssets(staging, output), /missing a nonempty regular/u);
        assert.deepEqual(await inventory(output), previous);
      });
    });
  }
}

for (const kind of ["directory", "symlink"] as const) {
  test(`publication rejects an extra ${kind} without touching the prior output`, async () => {
    await fixture(async (output, staging) => {
      const previous = await inventory(output);
      if (kind === "directory") await mkdir(join(staging, "extra"));
      else await symlink(output, join(staging, "extra"), "dir");
      await assert.rejects(publishBrowserAssets(staging, output), /contains a non-regular file/u);
      assert.deepEqual(await inventory(output), previous);
    });
  });
}

test("publication rejects HTML with missing browser references", async () => {
  await fixture(async (output, staging) => {
    const previous = await inventory(output);
    for (const source of ["<!doctype html>", '<script src="/app.js"></script>', '<link href="/app.css">']) {
      await writeFile(join(staging, "index.html"), source);
      await assert.rejects(publishBrowserAssets(staging, output), /must reference/u);
      assert.deepEqual(await inventory(output), previous);
    }
  });
});

for (const failure of ["validation", "incomplete", "publication"] as const) {
  test(`build ${failure} failure preserves complete output and cleans its staging`, async () => {
    await fixture(async (output) => {
      const previous = await inventory(output);
      let staged = "";
      await assert.rejects(
        buildBrowserAssets({
          outputDirectory: output,
          validateOutput: async (staging) => {
            staged = staging;
            if (failure === "validation") throw new Error("injected validation");
            if (failure === "incomplete") await rm(join(staging, "app.css"));
          },
          renamePath: async (source, destination) => {
            if (failure === "publication" && source === staged) throw new Error("injected publication");
            await rename(source, destination);
          },
        }),
        /injected|missing a nonempty regular/u,
      );
      assert.ok(staged);
      await assert.rejects(readdir(staged), { code: "ENOENT" });
      assert.deepEqual(await inventory(output), previous);
    });
  });
}

for (const failure of ["backup", "first-publication", "restoration"] as const) {
  test(`publication handles ${failure} rename failure`, async () => {
    await fixture(async (output, staging) => {
      const previous = await inventory(output);
      if (failure === "first-publication") await rm(output, { recursive: true });
      let calls = 0;
      await assert.rejects(
        publishBrowserAssets(staging, output, {
          renamePath: async (source, destination) => {
            calls++;
            if (failure !== "restoration" || calls >= 2) throw new Error("injected rename");
            await rename(source, destination);
          },
        }),
        failure === "restoration" ? /restoration failed; previous output is in/u : /injected rename/u,
      );
      if (failure === "backup") assert.deepEqual(await inventory(output), previous);
      if (failure === "first-publication") await assert.rejects(readdir(output), { code: "ENOENT" });
      if (failure === "restoration") {
        const backups = (await readdir(root)).filter((name) => join(root, name).startsWith(`${output}.backup-`));
        assert.equal(backups.length, 1);
        assert.deepEqual(await inventory(join(root, backups[0] as string)), previous);
      }
      assert.equal(await readFile(join(staging, "app.js"), "utf8"), 'console.log("next");');
    });
  });
}

test("output and staging ownership reject source, runtime, outside, nested, file and symlink paths", async () => {
  await fixture(async (output, staging) => {
    const previous = await inventory(output);
    for (const unowned of [
      root,
      join(root, "src"),
      join(root, "dist"),
      resolve(root, "../browser-dist"),
      join(output, "nested"),
    ]) {
      await assert.rejects(buildBrowserAssets({ outputDirectory: unowned }), /build-owned direct child/u);
      await assert.rejects(publishBrowserAssets(staging, unowned), /build-owned direct child/u);
      await assert.rejects(publishBrowserAssets(unowned, output), /build-owned direct child/u);
    }
    await rm(staging, { recursive: true });
    await symlink(output, staging, "dir");
    await assert.rejects(publishBrowserAssets(staging, output), /not a symlink or file/u);
    await rm(staging);
    for (const target of [join(root, "src"), join(root, "absent")]) {
      await rm(output, { recursive: true, force: true });
      await symlink(target, output, "dir");
      await assert.rejects(buildBrowserAssets({ outputDirectory: output }), /not a symlink or file/u);
      await rm(output);
    }
    await writeFile(output, "not a directory");
    await assert.rejects(buildBrowserAssets({ outputDirectory: output }), /not a symlink or file/u);
    await rm(output);
    await assets(output, "previous");
    assert.deepEqual(await inventory(output), previous);
  });
});

for (const replaced of ["output", "staging"] as const) {
  test(`publication rechecks ${replaced} ownership after asynchronous validation`, async () => {
    await fixture(async (output) => {
      const previous = await inventory(output);
      let staged = "";
      await assert.rejects(
        buildBrowserAssets({
          outputDirectory: output,
          validateOutput: async (staging) => {
            staged = staging;
            const path = replaced === "output" ? output : staging;
            await rm(path, { recursive: true });
            await symlink(replaced === "output" ? join(root, "src") : output, path, "dir");
          },
        }),
        /not a symlink or file/u,
      );
      await assert.rejects(readdir(staged), { code: "ENOENT" });
      if (replaced === "staging") assert.deepEqual(await inventory(output), previous);
    });
  });
}

for (const failure of ["browser", "runtime"] as const) {
  test(`package build and prepack stop when the ${failure} build fails`, async () => {
    const checkout = await mkdtemp(join(tmpdir(), "inspect-build-order-"));
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      await writeFile(
        join(checkout, "package.json"),
        JSON.stringify({ name: "inspect-build-order", version: "1.0.0", type: "module", scripts: manifest.scripts }),
      );
      await mkdir(join(checkout, "scripts"));
      for (const [file, stage] of [
        ["build.mjs", "browser"],
        ["build-runtime.mjs", "runtime"],
      ] as const) {
        await writeFile(
          join(checkout, "scripts", file),
          `import { appendFileSync } from "node:fs"; appendFileSync("order.log", ${JSON.stringify(`${stage}\n`)}); ${stage === failure ? 'throw new Error("injected build failure");' : ""}`,
        );
      }
      for (const args of [
        ["run", "build"],
        ["pack", "--pack-destination", checkout],
      ] as const) {
        await rm(join(checkout, "order.log"), { force: true });
        const npm = process.env.npm_execpath;
        assert.ok(npm, "Run package build tests through npm or npm exec");
        const result = spawnSync(process.execPath, [npm, ...args], { cwd: checkout, encoding: "utf8" });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /injected build failure/u);
        assert.equal(
          await readFile(join(checkout, "order.log"), "utf8"),
          failure === "browser" ? "browser\n" : "browser\nruntime\n",
        );
        assert.equal(
          (await readdir(checkout)).some((file) => file.endsWith(".tgz")),
          false,
        );
      }
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
}

// No root node_modules or dev dependencies: esbuild exists only in the package's dependency scope.
async function nestedCheckout(run: (checkout: string, packageRoot: string, script: string) => Promise<void>) {
  const checkout = await mkdtemp(join(tmpdir(), "inspect-browser-nested-"));
  const packageRoot = join(checkout, "packages/pi-inspect");
  const script = join(packageRoot, "scripts/build.mjs");
  try {
    await mkdir(dirname(script), { recursive: true });
    await cp(fileURLToPath(builderUrl), script);
    await mkdir(join(packageRoot, "src/web"), { recursive: true });
    await writeFile(join(packageRoot, "src/web/app.tsx"), 'import "./app.css"; console.log("production");');
    await writeFile(join(packageRoot, "src/web/app.css"), "body { color: red; }");
    const require = createRequire(builderUrl);
    await mkdir(join(packageRoot, "node_modules"));
    await symlink(dirname(require.resolve("esbuild/package.json")), join(packageRoot, "node_modules/esbuild"), "dir");
    await run(checkout, packageRoot, script);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

test("prepare's side-effect import works with nested production esbuild and leaves runtime dist untouched", async () => {
  await nestedCheckout(async (checkout, packageRoot, script) => {
    await mkdir(join(packageRoot, "dist"));
    await writeFile(join(packageRoot, "dist/index.ts"), "runtime sentinel");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`],
      {
        cwd: checkout,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(await inventory(join(packageRoot, "browser-dist"))), [
      "app.css",
      "app.js",
      "index.html",
    ]);
    assert.equal(await readFile(join(packageRoot, "dist/index.ts"), "utf8"), "runtime sentinel");
    await assert.rejects(readdir(join(checkout, "node_modules")), { code: "ENOENT" });
  });
});

test("esbuild source failure retains the prior browser directory and runtime without stale staging", async () => {
  await nestedCheckout(async (checkout, packageRoot, script) => {
    await assets(join(packageRoot, "browser-dist"), "previous");
    await mkdir(join(packageRoot, "dist"));
    await writeFile(join(packageRoot, "dist/index.ts"), "runtime sentinel");
    const previous = await inventory(join(packageRoot, "browser-dist"));
    await writeFile(join(packageRoot, "src/web/app.tsx"), "export {");
    const result = spawnSync(process.execPath, [script], { cwd: checkout, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected identifier/u);
    assert.deepEqual(await inventory(join(packageRoot, "browser-dist")), previous);
    assert.equal(await readFile(join(packageRoot, "dist/index.ts"), "utf8"), "runtime sentinel");
    assert.equal(
      (await readdir(packageRoot)).some((name) => name.startsWith(".inspect-browser-")),
      false,
    );
  });
});
