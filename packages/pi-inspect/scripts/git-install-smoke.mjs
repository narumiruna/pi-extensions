import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pi-inspect-git-install-"));
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}
try {
  // Like a fresh Git checkout: copy tracked/current source, never ignored browser assets or node_modules.
  const paths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)
    .split("\0")
    .filter(Boolean);
  for (const path of new Set(paths)) {
    try {
      await stat(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue; // Pending tracked deletions are not part of the checkout.
      throw error;
    }
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(root, path), join(directory, path));
  }
  const assets = join(directory, "packages/pi-inspect/browser-dist");
  await assert.rejects(stat(assets), { code: "ENOENT" });
  const npm = process.env.npm_execpath;
  assert(npm, "Run this smoke through the workspace npm script.");
  // These are Pi's npm Git-dependency flags, verified against its installed package manager.
  run(process.execPath, [npm, "install", "--omit=dev", "--legacy-peer-deps"], directory);
  for (const file of ["index.html", "app.js", "app.css"]) assert((await stat(join(assets, file))).size > 0);
  await assert.rejects(stat(join(directory, "node_modules/typescript")), { code: "ENOENT" });
  await assert.rejects(stat(join(directory, "packages/pi-inspect/dist")), { code: "ENOENT" });

  const { startServer } = await import(pathToFileURL(join(directory, "packages/pi-inspect/src/server.ts")).href);
  const server = await startServer({
    generation: "production-git-smoke",
    signal: new AbortController().signal,
    snapshot: () => ({ production: true }),
    branch: () => ({}),
    detail: () => ({}),
  });
  try {
    for (const route of ["/", "/app.js", "/app.css"]) {
      const response = await fetch(`${server.origin}${route}`);
      assert.equal(response.status, 200);
      assert((await response.text()).length > 0);
    }
    const response = await fetch(`${server.origin}/api/snapshot?generation=production-git-smoke`, {
      headers: { "X-Inspector-Token": server.token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { production: true });
  } finally {
    await server.close();
  }

  const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const helper = join(root, "packages/pi-inspect/test/reload-helper.ts");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--print",
      "--mode",
      "json",
      "--offline",
      "--no-session",
      "--no-skills",
      "--no-mcp",
      "--no-extensions",
      "--provider",
      "faux",
      "--model",
      "faux-1",
      "-e",
      helper,
      "-e",
      // Git installation retains source entries; prepare builds browser assets only.
      join(directory, "packages/pi-inspect/src/index.ts"),
      "/inspect",
    ],
    { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent") }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /requires TUI/);
  for (const line of result.stdout.split("\n").filter(Boolean)) JSON.parse(line);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert(manifest.pi.extensions.includes("./packages/pi-inspect/src/index.ts"));
  console.log(
    "Production Git checkout: no prebuilt assets/dev dependencies, install builds browser assets, serving and Pi loading passed",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
