import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, onTestFinished, test, vi } from "vitest";
import { ensureDaemon } from "../src/client.js";
import {
  daemonPaths,
  privateDirectory,
  processExited,
  publishIdentity,
  readJsonBody,
  readProcessBirth,
  readUpgradeOwner,
  recordUpgradeOwner,
  runtimePaths,
} from "../src/identity.js";
import type { Identity } from "../src/protocol.js";

const boot = "42a302bf-077f-4c3b-882a-fe13d3b6c2c3";
const birth = `${boot}:10.20:42`;
const pid = process.pid;
const errno = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => vi.restoreAllMocks());

function procfs() {
  const linux = { ticks: 42, available: true, namespace: "10", timeNamespace: "20", nsPid: String(pid) };
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    switch (args[0]) {
      case "/proc/self/status":
        return `NSpid:\t${linux.nsPid}\n`;
      case "/proc/sys/kernel/random/boot_id":
        return `${boot}\n`;
      case `/proc/${pid}/stat`:
        if (!linux.available) throw errno("ENOENT");
        return `${pid} (daemon ) with\nspaces) S ${"0 ".repeat(18)}${linux.ticks} 0\n`;
      default:
        return readFile(...args);
    }
  });
  const readlink = fs.readlink.bind(fs);
  vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
    if (args[0] === "/proc/self/ns/pid") {
      if (!linux.namespace) throw errno("ENOENT");
      return `pid:[${linux.namespace}]`;
    }
    if (args[0] === "/proc/self/ns/time") return `time:[${linux.timeNamespace}]`;
    return readlink(...args);
  });
  return linux;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-process-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await runtimePaths(root);
  await privateDirectory(paths.directory);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  const owner: Identity = { version: 1, root: paths.root, instance: randomUUID(), pid, token: "a".repeat(64) };
  return { paths, owner, file: path.join(paths.directory, "upgrade-owner.json") };
}

async function listenOlderDaemon({ paths, owner }: Awaited<ReturnType<typeof fixture>>, hello: () => void) {
  const endpoint = daemonPaths(paths, owner.instance);
  if (endpoint.endpointDirectory) await privateDirectory(endpoint.endpointDirectory);
  const server = createServer(async (request, response) => {
    const input = (await readJsonBody(request)) as Identity & { method: string };
    const { version, root, instance, token } = owner;
    if (input.version === version && input.root === root && input.instance === instance && input.token === token) {
      if (input.method === "hello") {
        hello();
        response.end(JSON.stringify({ result: { version, root, instance, pid } }));
      } else {
        // Force a safe failure after the barrier would have been published.
        response.end(JSON.stringify({ result: { stopping: false } }));
      }
    } else {
      response.statusCode = 403;
      response.end();
    }
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (endpoint.endpointDirectory) await fs.rm(endpoint.endpointDirectory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => server.listen(endpoint.endpoint, resolve).once("error", reject));
  await publishIdentity(paths, owner);
}

test.runIf(process.platform === "linux")(
  "uses the real Linux birth marker when procfs is available",
  async ({ skip }) => {
    const observed = await readProcessBirth(pid);
    if (observed === undefined) return skip();
    const fields = observed.split(":");
    assert.equal(await processExited({ pid, birth: observed }), false);
    fields[2] = String(BigInt(fields[2]) + 1n);
    assert.equal(await processExited({ pid, birth: fields.join(":") }), true);
  },
);

test.runIf(process.platform === "linux")("Linux PID reuse proves exit only with a usable birth marker", async () => {
  const linux = procfs();
  assert.equal(await readProcessBirth(pid), birth);
  assert.equal(await processExited({ pid, birth }), false);
  linux.ticks++;
  assert.equal(await processExited({ pid, birth }), true);
  assert.equal(await processExited({ pid }), false);
  linux.namespace = "11";
  assert.equal(await processExited({ pid, birth }), false);
  linux.namespace = "10";
  linux.timeNamespace = "21";
  assert.equal(await processExited({ pid, birth }), false);
  linux.timeNamespace = "20";
  linux.nsPid = `${pid} ${pid}`;
  assert.equal(await processExited({ pid, birth }), false);
  linux.nsPid = String(pid);
  linux.available = false;
  assert.equal(await processExited({ pid, birth }), false);
});

test("only ESRCH proves exit without a usable birth marker", async () => {
  const kill = process.kill.bind(process);
  let error = "EPERM";
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === pid && signal === 0) throw errno(error);
    return kill(target, signal);
  });
  try {
    assert.equal(await processExited({ pid }), false);
    error = "EINVAL";
    assert.equal(await processExited({ pid }), false);
    error = "ESRCH";
    assert.equal(await processExited({ pid }), true);
  } finally {
    spy.mockRestore();
  }
});

test.runIf(process.platform === "linux")(
  "ESRCH proves a marked owner's exit only in the same PID namespace",
  async () => {
    const linux = procfs();
    linux.available = false;
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid && signal === 0) throw errno("ESRCH");
      return kill(target, signal);
    });
    linux.namespace = "11";
    assert.equal(await processExited({ pid, birth }), false);
    linux.namespace = "";
    assert.equal(await processExited({ pid, birth }), false);
    linux.namespace = "10";
    assert.equal(await processExited({ pid, birth }), true);
  },
);

test("validates persisted births and still accepts legacy PID-only upgrade records", async () => {
  const {
    file,
    owner: { token: _, ...owner },
    paths,
  } = await fixture();
  const write = (value: object) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write(owner);
  assert.deepEqual(await readUpgradeOwner(paths), owner);
  await write({ ...owner, birth });
  assert.deepEqual(await readUpgradeOwner(paths), { ...owner, birth });
  for (const birth of [null, 42, "invalid", `${boot}:10.20:042`, `${boot}:10.20:18446744073709551616`]) {
    await write({ ...owner, birth });
    await assert.rejects(readUpgradeOwner(paths), /Invalid daemon upgrade record/u);
  }
});

test.runIf(process.platform === "linux")("startup no longer waits on a reused PID after identity release", async () => {
  const linux = procfs();
  const { paths, owner } = await fixture();
  await recordUpgradeOwner(paths, { ...owner, birth });
  linux.ticks++;
  // An unattended grant prevents a launch, but is checked only after the exit barrier.
  const state = path.join(paths.root, "pi-sync");
  await fs.mkdir(state);
  await fs.writeFile(
    path.join(state, "daemon.json"),
    JSON.stringify({
      version: 1,
      root: paths.root,
      handover: true,
      nonce: "0".repeat(64),
      setups: { active: { fingerprint: "1".repeat(64), afterExit: true } },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(ensureDaemon(paths.root, AbortSignal.timeout(2_000)), /revoke unattended Pi Sync permission/u);
  assert.equal((await readUpgradeOwner(paths))?.birth, birth);
});

test.runIf(process.platform === "linux")(
  "a retry preserves the birth authenticated on the first upgrade attempt",
  async () => {
    const linux = procfs();
    const owner = await fixture();
    let hellos = 0;
    await listenOlderDaemon(owner, () => {
      if (++hellos === 2) linux.ticks++;
    });
    await assert.rejects(ensureDaemon(owner.paths.root), /could not upgrade/u);
    const saved = await fs.readFile(owner.file, "utf8");
    assert.equal(JSON.parse(saved).birth, birth);
    assert.equal(Object.hasOwn(JSON.parse(saved), "token"), false);
    await assert.rejects(ensureDaemon(owner.paths.root), /could not upgrade/u);
    assert.equal(await fs.readFile(owner.file, "utf8"), saved);
  },
);

test.runIf(process.platform === "linux")(
  "a changed birth between the hello samples never becomes an upgrade owner",
  async () => {
    const linux = procfs();
    const owner = await fixture();
    await listenOlderDaemon(owner, () => linux.ticks++);
    await assert.rejects(ensureDaemon(owner.paths.root), /process changed during authentication/u);
    assert.equal(await readUpgradeOwner(owner.paths), undefined);
  },
);

test.runIf(process.platform === "linux")("a sample taken only after hello cannot prove process birth", async () => {
  const linux = procfs();
  linux.available = false;
  const owner = await fixture();
  await listenOlderDaemon(owner, () => {
    linux.available = true;
  });
  await assert.rejects(ensureDaemon(owner.paths.root), /could not upgrade/u);
  const recorded = await readUpgradeOwner(owner.paths);
  assert.equal(recorded?.pid, pid);
  assert.equal(Object.hasOwn(recorded ?? {}, "birth"), false);
});
