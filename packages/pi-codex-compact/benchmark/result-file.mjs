import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeResultFile(outputPath, value, options = {}) {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  const temporaryPath = path.join(directory, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const renameFile = options.renameFile ?? rename;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await renameFile(temporaryPath, resolved);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
