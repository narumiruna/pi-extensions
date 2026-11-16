import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

interface RunningCommand {
  child: ReturnType<typeof spawn>;
  closed: Promise<number | null>;
  exited: Promise<void>;
  output(): string;
  isClosed(): boolean;
  ready(): Promise<void>;
  message(type: string): Promise<void>;
}

// Deadlines start after the owner or preload has sent its readiness handshake.
async function afterReady<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Documentation subprocess did not settle")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  run: (root: string, start: (command: string, input?: boolean, hook?: string) => RunningCommand) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-docs-process-"));
  const children: RunningCommand[] = [];
  try {
    execFileSync("git", ["init", "--quiet", root]);
    for (const directory of ["docs", "packages", "scripts", "bin"]) await mkdir(join(root, directory));
    for (const name of ["docs.mjs", "docs-markdown.mjs"])
      await copyFile(resolve("scripts", name), join(root, "scripts", name));
    await writeFile(join(root, ".gitignore"), ".zensical-docs/\n.zensical-docs.lock\n");
    await writeFile(join(root, "docs/index.md"), "# Initial home\n");
    const uvx = join(root, "bin/uvx");
    await writeFile(
      uvx,
      `#!/usr/bin/env node
console.log("renderer-ready:" + process.pid);
process.stdin.on("data", () => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
`,
    );
    await chmod(uvx, 0o755);
    const start = (command: string, input = false, hook?: string): RunningCommand => {
      const child = spawn(
        process.execPath,
        [...(hook ? ["--import", pathToFileURL(hook).href] : []), join(root, "scripts/docs.mjs"), command],
        {
          cwd: root,
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      let output = "";
      let ended = false;
      child.stdout?.on("data", (bytes) => {
        output += bytes;
      });
      child.stderr?.on("data", (bytes) => {
        output += bytes;
      });
      const closed = new Promise<number | null>((done) =>
        child.once("close", (code) => {
          ended = true;
          done(code);
        }),
      );
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      const running: RunningCommand = {
        child,
        closed,
        exited,
        output: () => output,
        isClosed: () => ended,
        ready: () =>
          new Promise<void>((done, reject) => {
            const check = () => {
              if (output.includes("renderer-ready:")) {
                child.stdout?.removeListener("data", check);
                done();
              }
            };
            child.stdout?.on("data", check);
            child.once("error", reject);
            void closed.then(() => {
              if (!output.includes("renderer-ready:")) reject(new Error(output));
            });
            check();
          }),
        message: (type) =>
          new Promise<void>((done, reject) => {
            const receive = (value: unknown) => {
              if (typeof value === "object" && value !== null && "type" in value && value.type === type) {
                child.removeListener("message", receive);
                done();
              }
            };
            child.on("message", receive);
            if (ended) reject(new Error(output));
            else void closed.then(() => reject(new Error(`Missing ${type}: ${output}`)));
          }),
      };
      if (input) child.stdin?.end("finish\n");
      children.push(running);
      return running;
    };
    await run(root, start);
  } finally {
    for (const running of children) {
      if (running.isClosed()) continue;
      running.child.stdin?.end("finish\n");
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
      const pid = Number(running.output().match(/renderer-ready:(\d+)/)?.[1]);
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    await Promise.all(children.map((running) => running.closed));
    await rm(root, { recursive: true, force: true });
  }
}

for (const ownerCommand of ["build", "serve"]) {
  for (const contenderCommand of ["build", "serve"]) {
    test.skipIf(process.platform === "win32")(
      `${ownerCommand} excludes another ${contenderCommand} before staging or rendering`,
      async () => {
        await fixture(async (root, start) => {
          const owner = start(ownerCommand);
          await owner.ready();
          const before = await readFile(join(root, ".zensical-docs/index.md"), "utf8");
          await writeFile(join(root, "docs/index.md"), "# Changed source\n");
          const contender = start(contenderCommand, true);
          assert.equal(await afterReady(contender.closed), 1);
          assert.match(contender.output(), /Another documentation command owns/);
          assert.doesNotMatch(contender.output(), /renderer-ready:/);
          if (ownerCommand === "build")
            assert.equal(await readFile(join(root, ".zensical-docs/index.md"), "utf8"), before);
          assert.ok(existsSync(join(root, ".zensical-docs.lock")));
          owner.child.stdin?.end("finish\n");
          assert.equal(await afterReady(owner.closed), 0);
          assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
          const next = start("build", true);
          assert.equal(await afterReady(next.closed), 0, next.output());
        });
      },
    );
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test.skipIf(process.platform === "win32")(
    `${signal} stops the renderer and releases documentation ownership`,
    async () => {
      await fixture(async (root, start) => {
        const owner = start("serve");
        await owner.ready();
        owner.child.kill(signal);
        assert.equal(await afterReady(owner.closed), code, owner.output());
        assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
        assert.equal(await afterReady(start("build", true).closed), 0);
      });
    },
  );
}

async function publicationHook(root: string, publication: number): Promise<string> {
  const path = join(root, "pause-publication.mjs");
  await writeFile(
    path,
    `import fs from "node:fs/promises";
import processes from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
if (process.send) {
  const rename = fs.rename;
  let count = 0;
  fs.rename = async (...args) => {
    if (String(args[0]).endsWith("/.zensical-docs/index.md.tmp") && ++count === ${publication}) {
      process.send({ type: "publication-ready" });
      await new Promise(done => process.once("message", done));
    }
    return rename(...args);
  };
  const spawn = processes.spawn;
  processes.spawn = (...args) => {
    const child = spawn(...args);
    child.once("close", () => process.send({ type: "renderer-closed" }));
    return child;
  };
  syncBuiltinESMExports();
}
`,
  );
  return path;
}

test.skipIf(process.platform === "win32")(
  "shutdown keeps ownership until an admitted refresh finishes after renderer close",
  async () => {
    await fixture(async (root, start) => {
      const owner = start("serve", false, await publicationHook(root, 2));
      await owner.ready();
      const paused = owner.message("publication-ready");
      await writeFile(join(root, "docs/index.md"), "# Admitted refresh\n");
      await afterReady(paused);
      const rendererClosed = owner.message("renderer-closed");
      owner.child.kill("SIGINT");
      await afterReady(rendererClosed);
      assert.ok(existsSync(join(root, ".zensical-docs.lock")));
      const contender = start("build", true);
      assert.equal(await afterReady(contender.closed), 1, contender.output());
      owner.child.send({ type: "release" });
      assert.equal(await afterReady(owner.closed), 130, owner.output());
      assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
      assert.equal(await readFile(join(root, ".zensical-docs/index.md"), "utf8"), "# Admitted refresh\n");
    });
  },
);

test.skipIf(process.platform === "win32")(
  "cancellation during initial preparation does not start a renderer",
  async () => {
    await fixture(async (root, start) => {
      const owner = start("serve", false, await publicationHook(root, 1));
      await owner.message("publication-ready");
      owner.child.kill("SIGTERM");
      assert.equal(await afterReady(start("build", true).closed), 1);
      owner.child.send({ type: "release" });
      assert.equal(await afterReady(owner.closed), 143, owner.output());
      assert.doesNotMatch(owner.output(), /renderer-ready:/);
      assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
    });
  },
);

test.skipIf(process.platform === "win32")("preparation and child-start failures release ownership", async () => {
  await fixture(async (root, start) => {
    await writeFile(join(root, "docs/index.md"), "[Missing](missing.md)\n");
    const invalid = start("build", true);
    assert.equal(await invalid.closed, 1);
    assert.match(invalid.output(), /missing link target/);
    assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
    await writeFile(join(root, "docs/index.md"), "# Valid home\n");
    const hook = join(root, "missing-renderer.mjs");
    await writeFile(
      hook,
      `import processes from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = processes.spawn;
processes.spawn = (_command, args, options) => spawn("/nonexistent-pi-docs-renderer", args, options);
syncBuiltinESMExports();
`,
    );
    const missingChild = start("build", true, hook);
    assert.equal(await missingChild.closed, 1);
    assert.match(missingChild.output(), /ENOENT/);
    assert.doesNotMatch(missingChild.output(), /renderer-ready:/);
    assert.equal(existsSync(join(root, ".zensical-docs.lock")), false);
  });
});

test.skipIf(process.platform === "win32")("a dead owner is not replaced until explicit lock recovery", async () => {
  await fixture(async (root, start) => {
    const owner = start("serve");
    await owner.ready();
    const renderer = Number(owner.output().match(/renderer-ready:(\d+)/)?.[1]);
    owner.child.kill("SIGKILL");
    await afterReady(owner.exited);
    process.kill(renderer, "SIGTERM");
    await afterReady(owner.closed);
    assert.ok(existsSync(join(root, ".zensical-docs.lock")));
    const contender = start("build", true);
    assert.equal(await afterReady(contender.closed), 1, contender.output());
    await rm(join(root, ".zensical-docs.lock"));
    assert.equal(await afterReady(start("build", true).closed), 0);
  });
});
