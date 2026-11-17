import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown, options: { maxBytes?: number } = {}) {
  const content = `${JSON.stringify(value, null, "\t")}\n`;
  if (options.maxBytes !== undefined && Buffer.byteLength(content) > options.maxBytes)
    throw new Error(
      "Private state document exceeds its storage bound; preserve existing evidence and use reviewed recovery.",
    );
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await fs.chmod(temp, 0o600);
    await fs.rename(temp, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** POSIX rename/unlink durability; Windows does not expose directory fsync through Node. */
export async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
