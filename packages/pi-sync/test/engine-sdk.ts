import fs from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve the SDK's public import export in the engine's own npm install scope. */
export async function engineSdk() {
  const file = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.resolve("@narumitw/pi-sync-daemon"));
  if (!file) throw new Error("The engine SDK package is missing.");
  const manifest = JSON.parse(await fs.readFile(file, "utf8")) as { exports: { ".": { import: string } } };
  const entry = pathToFileURL(path.resolve(path.dirname(file), manifest.exports["."].import)).href;
  return import(entry) as Promise<typeof import("@earendil-works/pi-coding-agent")>;
}
