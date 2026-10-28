import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

test("the root build creates Kit output before consumers, without building Kit twice", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    workspaces: string[];
    scripts: { build: string };
  };
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-build-order-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: manifest.workspaces, scripts: { build: manifest.scripts.build } }),
    );
    for (const name of ["pi-agentfs", "pi-tui-kit"]) {
      const directory = join(root, "packages", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: `@narumitw/${name}`, type: "module", scripts: { build: "node build.mjs" } }),
      );
    }
    await writeFile(
      join(root, "packages/pi-tui-kit/build.mjs"),
      `import fs from "node:fs/promises";
await fs.mkdir(new URL("./dist/", import.meta.url));
await fs.writeFile(new URL("./dist/index.d.ts", import.meta.url), "export {};\\n");
await fs.appendFile(new URL("../../order.log", import.meta.url), "kit\\n");
`,
    );
    await writeFile(
      join(root, "packages/pi-agentfs/build.mjs"),
      `import fs from "node:fs/promises";
await fs.access(new URL("../pi-tui-kit/dist/index.d.ts", import.meta.url));
await fs.appendFile(new URL("../../order.log", import.meta.url), "consumer\\n");
`,
    );
    const npm = process.env.npm_execpath;
    const result = spawnSync(npm ? process.execPath : "npm", npm ? [npm, "run", "build"] : ["run", "build"], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(join(root, "order.log"), "utf8"), "kit\nconsumer\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
