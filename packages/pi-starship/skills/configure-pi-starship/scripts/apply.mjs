#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { backupExpectedDocument } from "./backup.mjs";
import { formatDisplayValue, formatError } from "./script-support.mjs";

/** Keep this script independent of the extension's generated runtime. */
export async function applyGuardedDocument(draftPath, destinationPath, expectedPath, options = {}) {
  let temporaryPath;
  let backupPath;
  let published = false;
  let failureMessage;
  try {
    const draft = await readFile(draftPath);
    parse(new TextDecoder("utf-8", { fatal: true }).decode(draft));
    const expectMissing = expectedPath === "--expect-missing";
    const expected = expectMissing ? undefined : await readFile(expectedPath);
    const initial = assertDestinationUnchanged(destinationPath, expectMissing, expected);
    if (expected?.equals(draft)) return { backupPath: undefined, unchanged: true };
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    temporaryPath = join(dirname(destinationPath), `.pi-starship.toml.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, draft, { flag: "wx", mode: 0o600, flush: true });
    assertDestinationUnchanged(destinationPath, expectMissing, expected, initial);
    backupPath =
      expected === undefined ? undefined : await (options.backup ?? backupExpectedDocument)(destinationPath, expected);
    // Backup has asynchronous durability boundaries. Recheck after them, then publish without an await gap.
    if (!readFileSync(draftPath).equals(draft)) {
      throw new Error("The draft changed during backup; review it again before applying.");
    }
    assertDestinationUnchanged(destinationPath, expectMissing, expected, initial);
    (options.rename ?? renameSync)(temporaryPath, destinationPath);
    temporaryPath = undefined;
    published = true;
    (options.syncDirectory ?? syncDirectory)(dirname(destinationPath));
    return { backupPath, unchanged: false };
  } catch (error) {
    const failure = published
      ? `Draft was published to ${formatDisplayValue(destinationPath)}, but its directory durability check failed: ${formatError(error)}`
      : `Draft was not applied to ${formatDisplayValue(destinationPath)}: ${formatError(error)}`;
    failureMessage = backupPath ? `${failure}\nRetained backup: ${formatDisplayValue(backupPath)}` : failure;
    if (temporaryPath) {
      try {
        await (options.remove ?? rm)(temporaryPath, { force: true });
      } catch (cleanupError) {
        failureMessage += `\nRemoving the staged document also failed: ${formatError(cleanupError)}. Temporary path: ${formatDisplayValue(temporaryPath)}`;
      }
    }
    throw new Error(failureMessage, { cause: error });
  }
}

function assertDestinationUnchanged(destinationPath, expectMissing, expected, initial) {
  let current;
  let info;
  try {
    info = lstatSync(destinationPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("The active settings path must be a regular file, not a symbolic link.");
    current = readFileSync(destinationPath);
    const after = lstatSync(destinationPath);
    if (after.dev !== info.dev || after.ino !== info.ino)
      throw new Error("The active settings file changed while being read.");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (expectMissing) return undefined;
      throw new Error("The active pi-starship.toml was removed after inspection.");
    }
    throw error;
  }
  if (
    !expectMissing &&
    expected !== undefined &&
    current.equals(expected) &&
    (!initial || (info.dev === initial.dev && info.ino === initial.ino))
  )
    return { dev: info.dev, ino: info.ino };
  throw new Error("The active pi-starship.toml changed after inspection; the newer file was preserved.");
}

function syncDirectory(directoryPath) {
  if (process.platform === "win32") return;
  const handle = openSync(directoryPath, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [draftPath, destinationPath, expectedPath, ...extraArguments] = process.argv.slice(2);
  if (!draftPath || !destinationPath || !expectedPath || extraArguments.length > 0) {
    console.error(
      "Usage: node scripts/apply.mjs <draft-path> <absolute-pi-starship.toml-path> <expected-path|--expect-missing>",
    );
    process.exitCode = 2;
  } else if (!isAbsolute(destinationPath) || basename(destinationPath) !== "pi-starship.toml") {
    console.error("The destination must be an absolute path named pi-starship.toml.");
    process.exitCode = 2;
  } else {
    try {
      const result = await applyGuardedDocument(draftPath, destinationPath, expectedPath);
      if (result.backupPath) console.log(`Backed up the previous TOML to ${formatDisplayValue(result.backupPath)}`);
      console.log(
        result.unchanged
          ? "The active TOML already matches the draft."
          : `Applied valid TOML atomically to ${formatDisplayValue(destinationPath)}`,
      );
    } catch (error) {
      console.error(formatError(error));
      process.exitCode = 1;
    }
  }
}
