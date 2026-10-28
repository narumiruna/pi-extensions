import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

async function smoke(discovered) {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-rpc-"));
  const cwd = join(root, "workspace");
  const agent = join(root, "agent");
  const skill = join(cwd, ".pi", "skills", "sample");
  await mkdir(skill, { recursive: true });
  await mkdir(agent);
  const linked = join(agent, "skills", "linked");
  const target = join(root, "source", "linked");
  const linkedContent = "---\nname: linked\ndescription: Linked RPC smoke skill\n---\nLinked instructions\n";
  await mkdir(target, { recursive: true });
  await mkdir(dirname(linked), { recursive: true });
  await writeFile(join(target, "SKILL.md"), linkedContent);
  await symlink(target, linked, "dir");
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: sample\ndescription: Isolated RPC smoke skill\n---\nInstructions\n",
  );
  if (discovered) {
    const directory = join(cwd, ".pi", "extensions");
    await mkdir(directory, { recursive: true });
    await symlink(dirname(extension), join(directory, "skills"), "dir");
  }
  const args = [
    cli,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--approve",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
  ];
  if (!discovered) args.push("--no-extensions", "-e", extension);
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    },
  });
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  let ready = false;
  let failure;
  const pending = new Map();
  const dialogs = [];
  const invocation = (value) => [
    ["Skills", "Manage skills"],
    [
      "Manage skills",
      `linked · ${value === "automatic" ? "Automatic" : "Manual only"} · User (Pi) · ${join(linked, "SKILL.md")}`,
    ],
    ["linked · User (Pi)", "Model invocation"],
    ["Review invocation target", "Open invocation setting"],
    ["Model invocation", `Model invocation (${value})`],
    ["Model invocation", "Back"],
    ["Review invocation target", "Back"],
    ["linked · User (Pi)", "Back"],
    ["Manage skills", "Back"],
    ["Skills", "Reload now"],
  ];
  const script = [
    ...invocation("automatic"),
    ...invocation("manual only"),
    ["Skills", "Manage skills"],
    ["Manage skills", `sample · Automatic · Project (Pi) · ${join(skill, "SKILL.md")}`],
    ["sample · Project (Pi)", "Remove…"],
    ["Confirm skill changes", "Apply changes"],
    ["Skill changes", "Reload now"],
    ["Skills", "Help"],
    ["Skills help", "Back"],
    ["Skills", "Close"],
  ];
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      for (const request of pending.values()) request.reject(new Error(`RPC exited (${code ?? signal}): ${stderr}`));
      pending.clear();
      resolve({ code, signal });
    });
  });
  const fail = (error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    child.kill();
  };
  child.once("error", fail);
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdout.on("data", (data) => {
    buffer += data.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "response") {
          const request = pending.get(message.id);
          if (request) {
            pending.delete(message.id);
            if (message.success) request.resolve(message.data);
            else request.reject(new Error(message.error));
          }
        } else if (message.type === "extension_ui_request" && message.method === "select") {
          const [title, value] = script.shift() ?? [];
          assert.ok(title && message.title.startsWith(title), `Unexpected RPC dialog: ${message.title}`);
          assert.ok(message.options.includes(value), `Missing RPC option ${value}: ${message.options}`);
          if (title === "Model invocation" || title === "Review invocation target")
            assert.ok(
              message.title.includes(`Writes target: ${join(target, "SKILL.md")}`),
              "Canonical write target must be visible before toggling",
            );
          dialogs.push({ title, value });
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, value })}\n`);
        } else if (
          message.type === "extension_ui_request" &&
          message.method === "notify" &&
          message.notifyType === "error"
        ) {
          throw new Error(`Extension error: ${message.message}`);
        }
      } catch (error) {
        fail(error);
      }
    }
  });
  async function request(type, fields = {}) {
    if (failure) throw failure;
    const id = `smoke-${++sequence}`;
    let timer;
    const work = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Start deadlines only after the server-observable readiness handshake.
      if (ready)
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC deadline: ${type}`));
        }, 5_000);
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
    try {
      return await work;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await request("get_state");
    ready = true;
    const commands = await request("get_commands");
    assert.equal(commands.commands.filter((command) => command.name === "skills").length, 1, stderr);
    assert.equal((await request("prompt", { message: "/skills" })).disposition, "handled");
    assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /disable-model-invocation: true/);
    const manualCommands = await request("get_commands");
    assert.ok(manualCommands.commands.some((command) => command.name === "skill:linked"));
    assert.equal((await request("prompt", { message: "/skills" })).disposition, "handled");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), linkedContent);
    const removal = await request("prompt", { message: "/skills" });
    assert.equal(removal.disposition, "handled");
    await assert.rejects(readFile(join(skill, "SKILL.md")), { code: "ENOENT" });
    const afterReload = await request("get_commands");
    assert.equal(afterReload.commands.filter((command) => command.name === "skills").length, 1);
    const beforeMenu = await request("get_messages");
    assert.equal((await request("prompt", { message: "/skills" })).disposition, "handled");
    const afterMenu = await request("get_messages");
    assert.deepEqual(afterMenu, beforeMenu, "Ordinary manager UI must not rewrite model-visible messages");
    assert.equal(script.length, 0);
    assert.equal(dialogs.length, 28);
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      assert.equal((await exited).code, 0, stderr);
    } finally {
      clearTimeout(deadline);
    }
    if (failure) throw failure;
    return {
      discovery: discovered ? "trusted-project" : "explicit-entrypoint",
      dialogs: dialogs.length,
      reload: "passed",
      invocation: "linked target round trip and manual skill retained after reload",
      prefix: "unchanged across ordinary menu",
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}

for (const discovered of [false, true]) console.log(JSON.stringify(await smoke(discovered)));
