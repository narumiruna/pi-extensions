import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

for (const mode of ["print", "json"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-headless-"));
  try {
    const child = spawn(
      process.execPath,
      [
        cli,
        ...(mode === "print" ? ["--print"] : ["--mode", "json"]),
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "-e",
        entrypoint,
        "/skills remove",
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          PI_CODING_AGENT_DIR: join(root, "agent"),
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.match(stdout + stderr, /\/skills requires Pi TUI or an RPC client with extension dialogs/);
    if (mode === "json") for (const line of stdout.split("\n").filter(Boolean)) JSON.parse(line);
    assert.ok(!(await readdir(root)).includes(".pi"), "Unsupported mode must not create project resources");
    console.log(JSON.stringify({ mode, rejection: "observable", protocol: "preserved", modelRequests: 0 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
