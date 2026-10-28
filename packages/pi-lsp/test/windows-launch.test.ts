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

for (const [suffix, companion, npmStyle] of [
  [".cmd", true, true],
  [".cmd", false, true],
  [".bat", false, false],
] as const) {
  test.skipIf(process.platform !== "win32")(
    `Windows LSP starts ${suffix} in a spaced path${companion ? " beside an npm POSIX shim" : ""}`,
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-windows-launch-"));
      const binName = npmStyle ? "bin with spaces" : "bin with spaces & (fixture)";
      const bin = path.join(root, binName);
      const record = path.join(root, "launch.json");
      mkdirSync(bin);
      const shim = path.join(bin, `language-server${suffix}`);
      // Match npm's forwarding boundary, where %* is parsed after endLocal.
      const body = npmStyle
        ? `@echo off\r\nsetlocal\r\nset "_prog=${process.execPath}"\r\nendLocal & "%_prog%" "${fixture}" %*\r\n`
        : `@echo off\r\nset "PI_LSP_TEST_BATCH_ARGUMENTS=%~2;%~3"\r\n"${process.execPath}" "${fixture}" %*\r\n`;
      writeFileSync(shim, body);
      if (companion) writeFileSync(path.join(bin, "language-server"), "#!/bin/sh\nexit 1\n");
      const command = { command: "language-server", args: [...args] };
      const adapter: LspServerAdapter = {
        name: "fixture",
        isDefault: false,
        defaultCommand: command,
        missingCommandHint: "Test fixture is required.",
        extensions: [".ts"],
        env: {
          Path: binName,
          PI_LSP_TEST_LAUNCH_RECORD: record,
          PI_LSP_TEST_ENV: "forwarded",
        },
        skipDirectories: new Set(),
        isSupportedFile: () => true,
        languageIdFor: () => "typescript",
      };
      const client = new LspClient(adapter, command, root, 1_000);
      try {
        await client.start();
        await client.initialize(root);
        const { pid, ...received } = JSON.parse(readFileSync(record, "utf8"));
        assert.deepEqual(received, {
          args,
          cwd: root,
          value: "forwarded",
          ...(!npmStyle ? { batchArguments: "--stdio;with spaces" } : {}),
        });
        await client.shutdown();
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
        assert.deepEqual(command.args, args, "launch must not mutate configured arguments");
      } finally {
        await client.shutdown();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
