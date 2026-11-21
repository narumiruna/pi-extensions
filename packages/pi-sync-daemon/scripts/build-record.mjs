import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const buildRecordName = ".daemon-build.json";

export async function recordDaemonBuild(root) {
  const files = await runtimeFiles(root);
  await writeFile(join(root, buildRecordName), JSON.stringify(await buildRecord(root, files)));
}

export async function readDaemonBuild(root) {
  const recorded = await readFile(join(root, buildRecordName), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Missing workspace daemon build record; build @narumitw/pi-sync-daemon first.");
  });
  const files = await runtimeFiles(root);
  if (recorded !== JSON.stringify(await buildRecord(root, files))) {
    throw new Error("Stale or mismatched workspace daemon build; rebuild @narumitw/pi-sync-daemon first.");
  }
  return files;
}

async function buildRecord(root, runtime) {
  const inputs = ["../../tsconfig.json", "package.json", "tsconfig.json", "tsconfig.build.json"];
  for (const file of await listFiles(join(root, "src"))) inputs.push(`src/${file}`);
  const inputHashes = await Promise.all(inputs.map(async (file) => [file, hash(await readFile(join(root, file)))]));
  return { inputs: inputHashes, runtime: [...runtime].map(([file, bytes]) => [file, hash(bytes)]) };
}

async function runtimeFiles(root) {
  const directory = join(root, "dist");
  const paths = (await listFiles(directory)).filter((file) => /\.js(?:\.map)?$/u.test(file));
  return new Map(await Promise.all(paths.map(async (file) => [file, await readFile(join(directory, file))])));
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, `${file}/`)));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unexpected workspace daemon file: ${file}`);
  }
  return files.sort();
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
