import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Identity, MAX_MESSAGE_BYTES, record } from "./protocol.js";

export interface RuntimePaths {
  root: string;
  directory: string;
  identity: string;
  startup: string;
  owner: string;
}
export function canonicalRootGuard(root: string) {
  const identity = lstatSync(root);
  return () => {
    const current = lstatSync(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      realpathSync(root) !== root
    )
      throw new Error("Canonical agent root changed; work stopped and recovery evidence retained.");
  };
}
export async function runtimePaths(root: string): Promise<RuntimePaths> {
  const canonical = await fs.realpath(path.resolve(root));
  const hash = createHash("sha256").update(canonical).digest("hex");
  const user = process.getuid?.() ?? createHash("sha256").update(os.homedir()).digest("hex").slice(0, 12);
  const base = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : "/tmp";
  // Keep the original namespace so the package rename cannot create a second root owner.
  const directory = path.join(base, `sync-daemon-${user}`, hash);
  return {
    root: canonical,
    directory,
    identity: path.join(directory, "identity.json"),
    startup: path.join(directory, "startup.lock"),
    owner: path.join(directory, "owner.lock"),
  };
}
export interface DaemonPaths extends RuntimePaths {
  endpoint: string;
  endpointDirectory?: string;
}
export function daemonPaths(paths: RuntimePaths, instance: string): DaemonPaths {
  const nonce = createHash("sha256").update(instance).digest("hex").slice(0, 16);
  const root = path.basename(paths.directory).slice(0, 16);
  const endpointDirectory = path.join(path.dirname(paths.directory), `${root}-${nonce}`);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\sync-daemon-${path.basename(path.dirname(paths.directory))}-${root}-${nonce}`
      : path.join(endpointDirectory, "api.sock");
  if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 103)
    throw new Error("Daemon endpoint path is too long.");
  return { ...paths, endpoint, ...(process.platform === "win32" ? {} : { endpointDirectory }) };
}
export async function privateDirectory(directory: string) {
  const parent = path.dirname(directory);
  if (parent !== path.dirname(parent) && path.basename(parent).startsWith("sync-daemon-"))
    await privateDirectory(parent);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("Unsafe daemon runtime directory.");
}
type OwnerRecord = Pick<Identity, "version" | "root" | "instance" | "pid">;
type ProcessIdentity = { pid: number; birth?: string };
/** The exit barrier records an authenticated owner without keeping its IPC token. */
export type UpgradeOwner = OwnerRecord & ProcessIdentity;
const birthPattern =
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:([1-9][0-9]{0,9})\.([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,19})$/u;
export function upgradeFile(paths: RuntimePaths) {
  return path.join(paths.directory, "upgrade-owner.json");
}
/** One private archive per upgrade instance, including across partial repair retries. */
export function upgradeArchivePath(paths: RuntimePaths, owner: Pick<UpgradeOwner, "instance">) {
  return path.join(paths.directory, `upgrade-recovery-${owner.instance}`);
}
/** A repair must finish explicitly once it starts changing consent or moving evidence. */
export async function upgradeRepairStarted(paths: RuntimePaths, owner: Pick<UpgradeOwner, "instance">) {
  try {
    await fs.lstat(upgradeArchivePath(paths, owner));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function readUpgradeOwner(paths: RuntimePaths): Promise<UpgradeOwner | undefined> {
  const value = await readPrivateRecord(upgradeFile(paths));
  if (value === undefined) return;
  if (!validOwner(value, paths.root) || (value.birth !== undefined && !validBirth(value.birth)))
    throw new Error("Invalid daemon upgrade record; state retained.");
  const { version, root, instance, pid, birth } = value;
  return birth === undefined ? { version, root, instance, pid } : { version, root, instance, pid, birth };
}
export function recordUpgradeOwner(paths: RuntimePaths, { version, root, instance, pid, birth }: UpgradeOwner) {
  return publishPrivateRecord(paths, upgradeFile(paths), { version, root, instance, pid, birth });
}
export function clearUpgradeOwner(paths: RuntimePaths) {
  return fs.rm(upgradeFile(paths), { force: true });
}
export async function readIdentity(paths: RuntimePaths): Promise<Identity | undefined> {
  const value = await readPrivateRecord(paths.identity);
  if (value === undefined) return;
  if (!validOwner(value, paths.root) || typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token))
    throw new Error("Invalid or incompatible daemon identity; state retained.");
  return { ...value, token: value.token };
}
function validBirth(value: unknown): value is string {
  const fields = typeof value === "string" && birthPattern.exec(value);
  return (
    !!fields &&
    Number(fields[1]) <= 0xffff_ffff &&
    Number(fields[2]) <= 0xffff_ffff &&
    BigInt(fields[3]) <= 0xffff_ffff_ffff_ffffn
  );
}
function validOwner(value: unknown, root: string): value is OwnerRecord & Record<string, unknown> {
  return (
    record(value) &&
    value.version === 1 &&
    value.root === root &&
    typeof value.instance === "string" &&
    /^[a-f0-9-]{36}$/u.test(value.instance) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) >= 1 &&
    Number(value.pid) <= 2_147_483_647
  );
}
async function readPrivateRecord(file: string): Promise<unknown> {
  let handle: fs.FileHandle | undefined;
  try {
    const before = await fs.lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 8192 ||
      (process.getuid && before.uid !== process.getuid()) ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0)
    )
      throw new Error("Unsafe daemon identity file.");
    handle = await fs.open(file, "r");
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino)
      throw new Error("Daemon identity changed while opening.");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  } finally {
    await handle?.close();
  }
}
export function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function readPidNamespace() {
  const scope = await fs.readlink("/proc/self/ns/pid");
  return /^pid:\[([0-9]+)\]$/u.exec(scope)?.[1];
}

/** Linux start ticks from a procfs view that agrees with the caller's PID namespace. */
export async function readProcessBirth(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return;
  try {
    const [status, pidNamespace, timeScope, boot, stat] = await Promise.all([
      fs.readFile("/proc/self/status", "utf8"),
      readPidNamespace(),
      fs.readlink("/proc/self/ns/time"),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    if (/^NSpid:[\t ]+([0-9]+)[\t ]*$/mu.exec(status)?.[1] !== String(process.pid)) return;
    // The kernel offsets start ticks using the reader's time namespace.
    const timeNamespace = /^time:\[([0-9]+)\]$/u.exec(timeScope)?.[1];
    if (pidNamespace === undefined || timeNamespace === undefined || !stat.startsWith(`${pid} (`)) return;
    // The parenthesized comm can contain spaces, parentheses, and newlines. Starttime is field 22.
    const end = stat.lastIndexOf(") ");
    if (end < String(pid).length + 2) return;
    const ticks = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/u)[19];
    const birth = `${boot.trim()}:${pidNamespace}.${timeNamespace}:${ticks}`;
    if (validBirth(birth)) return birth;
  } catch {
    // Missing or unreadable procfs is not evidence of process exit.
  }
}
/** A marked owner must be visible in the same PID namespace before absence proves exit. */
export async function processExited({ pid, birth }: ProcessIdentity): Promise<boolean> {
  const exists = processExists(pid);
  if (birth === undefined) return !exists; // Legacy PID-only records.
  if (process.platform !== "linux" || !validBirth(birth)) return false;
  const namespaces = birth.split(":")[1];
  if (!exists) {
    try {
      return (await readPidNamespace()) === namespaces.split(".")[0];
    } catch {
      return false;
    }
  }
  const current = await readProcessBirth(pid);
  return current !== undefined && current !== birth && current.split(":")[1] === namespaces;
}
export function publishIdentity(paths: RuntimePaths, identity: Identity) {
  return publishPrivateRecord(paths, paths.identity, identity);
}
async function publishPrivateRecord(paths: RuntimePaths, file: string, value: object) {
  const temporary = path.join(paths.directory, `.${randomUUID()}.json`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}
export async function readJsonBody(source: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > MAX_MESSAGE_BYTES) throw new Error("Daemon request exceeds its byte limit.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
