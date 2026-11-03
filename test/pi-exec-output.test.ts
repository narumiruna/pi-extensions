import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";

async function withExec(run: (exec: ExtensionAPI["exec"], directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-exec-output-"));
  const settings = SettingsManager.inMemory({ enableInstallTelemetry: false, enableAnalytics: false });
  let exec: ExtensionAPI["exec"] | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          exec = pi.exec;
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(exec);
    await run(exec, directory);
  } finally {
    await settings.flush();
    await rm(directory, { recursive: true, force: true });
  }
}

test("native pi.exec retains complete output at the combined byte limit", async () => {
  await withExec(async (exec) => {
    const result = await exec(process.execPath, ["-e", "process.stdout.write('ab'); process.stderr.write('cd')"], {
      maxBuffer: 4,
    });
    assert.deepEqual(result, { stdout: "ab", stderr: "cd", code: 0, killed: false, truncated: false });
  });
});

test("native pi.exec rejects overflow with partial structured output", async () => {
  await withExec(async (exec) => {
    const result = await exec(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({records: ['a', 'b', 'c']}))"],
      { maxBuffer: 12 },
    );
    assert.equal(result.stdout, '{"records":[');
    assert.equal(result.truncated, true);
    assert.equal(result.killed, true);
    assert.notEqual(result.code, 0);
    assert.throws(() => JSON.parse(result.stdout));
  });
});

test("native pi.exec bounds stdout and stderr together", async () => {
  await withExec(async (exec) => {
    const result = await exec(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))"],
      { maxBuffer: 128 },
    );
    assert.equal(result.truncated, true);
    assert.equal(result.killed, true);
    assert.notEqual(result.code, 0);
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 128);
  });
});

test("native pi.exec preserves UTF-8 across stdout and stderr writes", async () => {
  await withExec(async (exec) => {
    const source = `
      const bytes = Buffer.from('界🙂');
      process.stdout.write(bytes.subarray(0, 1));
      process.stderr.write(bytes.subarray(0, 2));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(1));
        process.stderr.write(bytes.subarray(2));
      }, 20);
    `;
    const result = await exec(process.execPath, ["-e", source], { maxBuffer: 14 });
    assert.deepEqual(result, { stdout: "界🙂", stderr: "界🙂", code: 0, killed: false, truncated: false });
  });
});

test("native pi.exec drops incomplete UTF-8 suffixes at the byte limit", async () => {
  await withExec(async (exec) => {
    for (const stream of ["stdout", "stderr"]) {
      const result = await exec(process.execPath, ["-e", `process.${stream}.write('界🙂')`], { maxBuffer: 2 });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(result.truncated, true);
      assert.equal(result.killed, true);
      assert.notEqual(result.code, 0);
    }
  });
});

test("native pi.exec retains spawn failure diagnostics without reporting overflow", async () => {
  await withExec(async (exec, directory) => {
    const result = await exec(join(directory, "missing-command"), [], { maxBuffer: 4 * 1024 });
    assert.equal(result.code, 1);
    assert.equal(result.killed, false);
    assert.equal(result.truncated, false);
    assert.match(result.stderr, /ENOENT|not found|cannot find/iu);
  });
});

async function stoppedChild(kind: "timeout" | "abort"): Promise<void> {
  await withExec(async (exec, directory) => {
    const controller = new AbortController();
    const readyPath = join(directory, "ready");
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const watcher = watch(directory, (_event, filename) => {
      if (filename === "ready") ready();
    });
    // Freeze Pi's timeout until the child confirms readiness; process startup is not timed.
    if (kind === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = exec(
      process.execPath,
      [
        "-e",
        `
      require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      setInterval(() => {}, 1000);
    `,
      ],
      {
        signal: controller.signal,
        ...(kind === "timeout" ? { timeout: 1000 } : {}),
        maxBuffer: 4 * 1024,
      },
    );
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Child exited before readiness");
        }),
      ]);
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(1000);
      else controller.abort();
      const result = await running;
      assert.equal(result.killed, true);
      assert.equal(result.truncated, false);
      assert.equal(result.stdout, "");
    } finally {
      controller.abort();
      watcher.close();
      vi.useRealTimers();
      await running;
    }
  });
}

test("native pi.exec retains timeout classification after child readiness", async () => stoppedChild("timeout"));
test("native pi.exec retains abort classification after child readiness", async () => stoppedChild("abort"));
