import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const buildRecordName = ".daemon-build.json";
const buildIdName = "build-id.json";

export async function recordDaemonBuild(root, before) {
  const files = await runtimeFiles(root);
  const { hashes } = await captureDaemonInputs(root);
  if (JSON.stringify(before.hashes) !== JSON.stringify(hashes)) {
    throw new Error("Daemon build inputs changed during compilation; rebuild @narumitw/pi-sync-daemon.");
  }
  const record = buildRecord(before.hashes, files);
  await writeFile(join(root, "dist", buildIdName), buildIdBytes(record));
  await writeFile(join(root, buildRecordName), JSON.stringify(record));
}

export async function readDaemonBuild(root) {
  const recorded = await readFile(join(root, buildRecordName), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Missing workspace daemon build record; build @narumitw/pi-sync-daemon first.");
  });
  const files = await runtimeFiles(root);
  const { hashes, manifest } = await captureDaemonInputs(root);
  const record = buildRecord(hashes, files);
  if (recorded !== JSON.stringify(record)) {
    throw new Error("Stale or mismatched workspace daemon build; rebuild @narumitw/pi-sync-daemon first.");
  }
  const id = await readFile(join(root, "dist", buildIdName), "utf8");
  if (id !== buildIdBytes(record))
    throw new Error("Mismatched daemon build identifier; rebuild @narumitw/pi-sync-daemon.");
  files.set(buildIdName, Buffer.from(id));
  return { manifest: manifest.toString("utf8"), files };
}

export async function captureDaemonInputs(root) {
  const manifest = await readFile(join(root, "package.json"));
  const inputs = ["../../tsconfig.json", "tsconfig.json", "tsconfig.build.json"];
  for (const file of await listFiles(join(root, "src"))) inputs.push(`src/${file}`);
  const hashes = await Promise.all(inputs.map(async (file) => [file, hash(await readFile(join(root, file)))]));
  return { manifest, hashes: [["package.json", hash(manifest)], ...hashes] };
}

function buildRecord(inputs, runtime) {
  return { inputs, runtime: [...runtime].map(([file, bytes]) => [file, hash(bytes)]) };
}

function buildIdBytes(record) {
  const executables = record.runtime.filter(([file]) => file.endsWith(".js"));
  return `${JSON.stringify(hash(JSON.stringify(executables)))}\n`;
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
