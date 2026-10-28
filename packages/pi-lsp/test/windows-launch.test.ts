import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import type { LspServerAdapter } from "../src/types.js";

const fixture = path.resolve("packages/pi-lsp/test/fixtures/windows-launch-server.mjs");
const args = [
  "",
  "--stdio",
  "with spaces",
  'say "hello"',
  "C:\\path with spaces\\",
  'backslash\\"quote',
  "%PATH%",
  "!literal!",
  "^caret",
  "(parentheses)",
  "x|y",
  "<input >output",
  'x"& echo unexpected-command & "y',
  "semicolon;comma,wildcards*?",
  "日本語",
  '"',
  '""',
  '"quoted"',
  ...[1, 2, 3, 4].flatMap((count) => [
    `${"\\".repeat(count)}"`,
    `path with spaces${"\\".repeat(count)}`,
    `prefix${"\\".repeat(count)}"suffix`,
  ]),
];

const commonArgs = ["", "--stdio", "with spaces", "a&b", 'quote"inside', "%PATH%", "trailing\\", "日本語"];

interface BatchVariant {
  suffix: ".cmd" | ".bat";
  companion: boolean;
  npmStyle: boolean;
  nodeModules?: boolean;
}

const variants: BatchVariant[] = [
  { suffix: ".cmd", companion: true, npmStyle: true },
  { suffix: ".cmd", companion: false, npmStyle: true },
  { suffix: ".cmd", companion: false, npmStyle: true, nodeModules: true },
  { suffix: ".bat", companion: false, npmStyle: false },
];

for (const variant of variants) {
  const name = `${variant.suffix}${variant.companion ? " beside a POSIX shim" : ""}${variant.nodeModules ? " in node_modules/.bin" : ""}`;
  const windowsTest = test.skipIf(process.platform !== "win32");
  windowsTest(`Windows LSP starts ${name} with a relative child PATH and common arguments`, async () => {
    await checkLaunch(commonArgs, variant);
  });

  // Keep the original complete argv matrix executable. cross-spawn does not yet
  // preserve every quote/backslash combination; it can corrupt argv or prevent
  // startup. A future fix must turn these into ordinary passing regressions.
  // The passing common-argument and native controls check fixture startup too.
  windowsTest.fails(`known cross-spawn limitation: ${name} preserves the complete argv matrix`, async () => {
    await checkLaunch(args, variant);
  });
}

test("native LSP executables preserve the complete argv matrix without batch parsing", async () => {
  await checkLaunch(args);
});

async function checkLaunch(values: string[], variant?: BatchVariant) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-launch-"));
  const record = path.join(root, "launch.json");
  const command = { command: process.execPath, args: [fixture, ...values] };
  const env: Record<string, string> = {
    PI_LSP_TEST_LAUNCH_RECORD: record,
    PI_LSP_TEST_ENV: "forwarded",
  };
  let client: LspClient | undefined;
  let pid: number | undefined;
  try {
    if (variant) {
      const parent = variant.npmStyle ? "bin with spaces" : "bin with spaces & (fixture)";
      const binName = variant.nodeModules ? path.join(parent, "node_modules", ".bin") : parent;
      const bin = path.join(root, binName);
      mkdirSync(bin, { recursive: true });
      // Match npm's forwarding boundary, where %* is parsed after endLocal.
      const body = variant.npmStyle
        ? `@echo off\r\nsetlocal\r\nset "_prog=${process.execPath}"\r\nendLocal & "%_prog%" "${fixture}" %*\r\n`
        : `@echo off\r\nset "PI_LSP_TEST_BATCH_ARGUMENTS=%~2;%~3"\r\n"${process.execPath}" "${fixture}" %*\r\n`;
      writeFileSync(path.join(bin, `language-server${variant.suffix}`), body);
      if (variant.companion) writeFileSync(path.join(bin, "language-server"), "#!/bin/sh\nexit 1\n");
      command.command = "language-server";
      command.args = [...values];
      env.Path = binName;
    }
    const originalArgs = [...command.args];
    const adapter: LspServerAdapter = {
      name: "fixture",
      isDefault: false,
      defaultCommand: command,
      missingCommandHint: "Test fixture is required.",
      extensions: [".ts"],
      env,
      skipDirectories: new Set(),
      isSupportedFile: () => true,
      languageIdFor: () => "typescript",
    };
    client = new LspClient(adapter, command, root, 1_000);
    await client.start();
    await client.initialize(root);
    const received = JSON.parse(readFileSync(record, "utf8"));
    pid = received.pid;
    delete received.pid;
    assert.deepEqual(received, {
      args: values,
      cwd: root,
      value: "forwarded",
      ...(variant && !variant.npmStyle ? { batchArguments: "--stdio;with spaces" } : {}),
    });
    assert.deepEqual(command.args, originalArgs, "launch must not mutate configured arguments");
  } finally {
    try {
      await client?.shutdown();
      const childPid = pid;
      if (childPid !== undefined) assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
