#!/usr/bin/env node
// Bounded native CLI reference + simulated BTW frames. No provider request is made.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { answer, question, response } from "./appearance-capture-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = resolve(process.argv[2] ?? repositoryRoot);
const output = resolve(process.argv[3] ?? "/tmp/pi-btw-appearance-frames.json");
const fixture = fileURLToPath(new URL("./appearance-capture-fixture.ts", import.meta.url));
const cli = join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const root = await mkdtemp(join(tmpdir(), "pi-btw-appearance-"));
const states = ["empty", "answered", "waiting", "error", "queued", "multiline", "focus-side", "focus-main"];
const frames = [];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let child;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
async function until(check, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (cancelled) throw new Error("Capture cancelled");
    if (Date.now() >= deadline) throw new Error(`${label} deadline exceeded`);
    await delay(20);
  }
}
try {
  const cwd = join(root, "workspace");
  const agent = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agent);
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      theme: "dark",
      quietStartup: true,
      editorPaddingX: 0,
      outputPad: 1,
      enableInstallTelemetry: false,
      fullscreenExitOutput: "resume-hint",
    }),
  );
  // Isolated model metadata and a dummy key make the native footer deterministic.
  // The fixture aborts held runs at agent_start before any provider request; this endpoint is never used.
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        anthropic: {
          baseUrl: "http://127.0.0.1:9",
          api: "anthropic-messages",
          apiKey: "appearance-fixture-not-a-secret",
          models: [
            {
              id: "claude-sonnet-4-5",
              name: "Appearance fixture",
              reasoning: true,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  for (const state of states) {
    const session = SessionManager.create(cwd, join(root, "sessions"));
    session.appendModelChange("anthropic", "claude-sonnet-4-5");
    session.appendThinkingLevelChange("medium");
    if (state !== "empty") {
      session.appendMessage({ role: "user", content: question, timestamp: 0 });
      session.appendMessage(
        state === "error"
          ? { ...response(""), stopReason: "error", errorMessage: "Fixture failure" }
          : response(answer),
      );
    }
    if (state === "waiting" || state === "queued") {
      session.appendMessage({ role: "user", content: "Pending 中文 🙂", timestamp: 0 });
    }
    const config = join(root, `${state}-config.json`);
    const ready = join(root, `${state}-ready`);
    const captured = join(root, `${state}-frame.json`);
    const violation = join(root, `${state}-provider-violation`);
    await writeFile(config, JSON.stringify({ sourceRoot, state, ready, output: captured, violation }));
    const args = [
      process.execPath,
      cli,
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--tui-mode",
      "fullscreen",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--thinking",
      "medium",
      "--session",
      session.getSessionFile(),
      "-e",
      fixture,
      "--appearance-config",
      config,
    ];
    const command = `stty cols 80 rows 24; exec ${args.map(quote).join(" ")}`;
    let transcript = "";
    let closed;
    let inputError;
    child = spawn("/usr/bin/script", ["-qefc", command, "/dev/null"], {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      closed = { error: String(error) };
    });
    child.stdin.on("error", (error) => {
      inputError = error;
    });
    const exited = new Promise((resolveExit) =>
      child.once("close", (code, signal) => {
        closed = { code, signal };
        resolveExit(closed);
      }),
    );
    child.stdout.setEncoding("utf8").on("data", (data) => {
      transcript += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      transcript += data;
    });
    try {
      await until(() => existsSync(ready) || closed, 30_000, `${state} startup`);
      assert.ok(existsSync(ready), `CLI exited before readiness: ${JSON.stringify(closed)} ${transcript}`);
      // The operation deadline starts only after session_start writes readiness.
      child.stdin.write("/appearance-capture\r");
      await until(() => existsSync(captured) || closed || inputError, 15_000, `${state} capture`);
      assert.ok(existsSync(captured), `CLI stopped before frame: ${inputError ?? transcript}`);
      const frame = JSON.parse(await readFile(captured, "utf8"));
      assert.equal(frame.error, undefined, frame.stack);
      assert.deepEqual(frame.dimensions, [80, 24]);
      await until(() => closed, 5_000, `${state} shutdown`);
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.ok(!existsSync(violation), "Capture reached before_provider_request");
      frames.push(frame);
    } catch (error) {
      await writeFile(`${output}.failure.txt`, transcript);
      throw error;
    } finally {
      if (!closed) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        await Promise.race([exited, delay(1_000)]);
        if (!closed) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          await exited;
        }
      }
      child = undefined;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        sourceRoot,
        runtimeRoot: repositoryRoot,
        theme: "dark",
        editorPaddingX: 0,
        outputPad: 1,
        nativeCapture: "actual repository CLI under script PTY; public TuiAltScreen.getScreenLines",
        btwCapture: "source component in simulated TuiAltScreen; same CLI callback theme and keybindings",
        frames,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Captured ${frames.length} native/BTW frames: ${output}`);
} finally {
  cancel();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  await rm(root, { recursive: true, force: true });
}
