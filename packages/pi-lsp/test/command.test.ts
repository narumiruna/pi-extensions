import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { resolveCommandPath } from "../src/command.js";
import { resolveSpawnCommand } from "../src/lsp-client.js";

for (const [files, expected] of [
  [["biome", "biome.cmd", "biome.bat", "biome.exe"], "biome.exe"],
  [["biome", "biome.cmd", "biome.bat"], "biome.cmd"],
  [["biome", "biome.bat"], "biome.bat"],
  [["biome"], "biome"],
] as const) {
  test(`Windows command lookup prefers ${expected} among ${files.join(", ")}`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-command-order-"));
    try {
      for (const file of files) writeFileSync(path.join(root, file), "fixture\n");
      assert.equal(resolveCommandPath("biome", root, "win32", root), path.join(root, expected));
      assert.equal(resolveCommandPath("./biome", root, "win32", ""), path.join(root, expected));
      assert.equal(resolveCommandPath(path.join(root, "biome"), root, "win32", ""), path.join(root, expected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Windows lookup preserves explicit suffixes and does not substitute a suffixed sibling", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-explicit-command-"));
  try {
    for (const name of ["tool.cmd", "tool.cmd.exe", "missing.bat.exe"])
      writeFileSync(path.join(root, name), "fixture\n");
    assert.equal(resolveCommandPath("tool.cmd", root, "win32", root), path.join(root, "tool.cmd"));
    assert.equal(resolveCommandPath("./tool.cmd", root, "win32", ""), path.join(root, "tool.cmd"));
    assert.equal(resolveCommandPath("missing.bat", root, "win32", root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows lookup preserves PATH directory precedence and resolves relative entries from child cwd", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-command-path-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, "tool.cmd"), "fixture\n");
    writeFileSync(path.join(second, "tool.exe"), "fixture\n");
    assert.equal(resolveCommandPath("tool", root, "win32", "first;second"), path.join(first, "tool.cmd"));
    assert.equal(resolveCommandPath("tool", root, "win32", "second;first"), path.join(second, "tool.exe"));
    mkdirSync(path.join(first, "directory.cmd"));
    assert.equal(resolveCommandPath("directory", root, "win32", first), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "POSIX lookup keeps the extensionless executable and execute permission checks",
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-posix-command-"));
    const command = path.join(root, "tool");
    try {
      writeFileSync(command, "#!/bin/sh\nexit 0\n");
      writeFileSync(`${command}.cmd`, "fixture\n");
      chmodSync(command, 0o755);
      assert.equal(resolveCommandPath("tool", root, process.platform, root), command);
      chmodSync(command, 0o644);
      assert.equal(resolveCommandPath("tool", root, process.platform, root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Windows batch wrapping uses one verbatim command line and the configured command processor", () => {
  const command = { command: "C:\\tools with spaces\\server.CMD", args: ["--stdio"] };
  const args = ["/d", "/s", "/c", '"C:\\tools^ with^ spaces\\server.CMD ^"--stdio^""'];
  assert.deepEqual(resolveSpawnCommand(command, "win32", " C:\\Windows\\System32\\cmd.exe "), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args,
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(resolveSpawnCommand(command, "win32", " "), {
    command: "cmd.exe",
    args,
    windowsVerbatimArguments: true,
  });
});

test("native executables and non-Windows commands do not use shell parsing", () => {
  for (const [command, platform] of [
    [{ command: "C:\\bin with spaces\\server.exe", args: ["a & b", ""] }, "win32"],
    [{ command: "/bin/server.cmd", args: ["a & b", ""] }, "linux"],
  ] as const) {
    const input = { command: command.command, args: [...command.args] };
    assert.equal(resolveSpawnCommand(input, platform), input);
  }
});
