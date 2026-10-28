import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import {
  type ContinuousRecord,
  continuousStatusLines,
  REQUEST_WINDOW_MS,
  readContinuousRecord,
  reserveContinuousRequest,
} from "../src/sync/continuous-record.js";
import {
  CONTINUOUS_RECORD_MAX_BYTES,
  continuousBinding,
  continuousRoot,
  hashContinuous,
} from "../src/sync/continuous-storage.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);
const now = 1_800_000_000_000;
const key = hashContinuous("private-candidate-evidence");

async function configured(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const settings = v3S3Settings();
  Object.assign(settings.syncSetups.home.sync, { continuous: true, agentMode: true });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
  return loadConfig();
}

function recordFor(binding: string): ContinuousRecord {
  return { version: 1, binding, pending: true, phase: "waiting", next: 0, failures: 0, calls: [], attempts: {} };
}

function serialize(record: ContinuousRecord) {
  return `${JSON.stringify(record, null, "\t")}\n`;
}

async function store(config: AnySyncConfig, change: (record: ContinuousRecord) => void = () => {}) {
  const binding = await continuousBinding(config);
  const record = recordFor(binding);
  change(record);
  await fs.mkdir(continuousRoot(), { recursive: true, mode: 0o700 });
  const file = path.join(continuousRoot(), `${binding}.json`);
  await fs.writeFile(file, serialize(record), { mode: 0o600 });
  return { binding, record, file };
}

/** Compare names, types, permissions and exact bytes, not access timestamps changed by reads. */
async function tree(root: string): Promise<unknown> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const file = path.join(root, entry.name);
        const stat = await fs.lstat(file);
        return [
          entry.name,
          stat.mode,
          entry.isDirectory() ? await tree(file) : (await fs.readFile(file)).toString("hex"),
        ];
      }),
  );
}

async function unchangedStatus(agentDir: string, config: AnySyncConfig) {
  const before = await tree(agentDir);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Status must not request a provider"));
  const mkdir = vi.spyOn(fs, "mkdir");
  const rename = vi.spyOn(fs, "rename");
  const writeFile = vi.spyOn(fs, "writeFile");
  try {
    const lines = await continuousStatusLines(config, () => now);
    assert.equal(fetch.mock.calls.length, 0);
    assert.equal(mkdir.mock.calls.length, 0);
    assert.equal(rename.mock.calls.length, 0);
    assert.equal(writeFile.mock.calls.length, 0);
    assert.deepEqual(await tree(agentDir), before);
    return lines.join("\n");
  } finally {
    fetch.mockRestore();
    mkdir.mockRestore();
    rename.mockRestore();
    writeFile.mockRestore();
  }
}

for (const scenario of [
  { name: "expired window", times: [now - REQUEST_WINDOW_MS, now - REQUEST_WINDOW_MS - 1], used: 0, next: "now" },
  { name: "partially expired window", times: [now - REQUEST_WINDOW_MS, now - 1], used: 1, next: "now" },
  {
    name: "full window with unsorted calls",
    times: [now - 1, now - REQUEST_WINDOW_MS + 100],
    used: 2,
    next: new Date(now + 100).toISOString(),
  },
  {
    name: "backward clock",
    times: [now + REQUEST_WINDOW_MS, now + REQUEST_WINDOW_MS + 100],
    used: 2,
    next: new Date(now + REQUEST_WINDOW_MS).toISOString(),
  },
]) {
  test(`Status normalizes ${scenario.name} without expiring or repairing durable evidence`, async () =>
    withTempHome(async (agentDir) => {
      const config = await configured(agentDir);
      const { record } = await store(config, (record) => {
        record.calls = scenario.times.map((at) => ({ key, at }));
        record.attempts[key] = 2;
        record.next = now + REQUEST_WINDOW_MS * 20;
        record.phase = "retry";
        record.error = "budget";
      });
      const text = await unchangedStatus(agentDir, config);
      assert.match(text, new RegExp(`${scenario.used}/2 used; ${2 - scenario.used} remaining`));
      assert.ok(text.includes(`Next request eligibility: ${scenario.next}`));
      assert.match(text, /Spent candidates: 1 exhausted \/ 1 tracked/);
      assert.ok(text.includes(`Accounting: ${Buffer.byteLength(serialize(record))}/${CONTINUOUS_RECORD_MAX_BYTES}`));
      assert.ok(text.includes(`Next background attempt: ${new Date(now + REQUEST_WINDOW_MS).toISOString()}`));
      assert.ok(!text.includes(key));
    }));
}

test("Status with no accounting record creates no directory, lease or allowance reservation", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    const text = await unchangedStatus(agentDir, config);
    assert.match(text, /no accounting record yet/);
    assert.match(text, /0\/2 used; 2 remaining/);
    assert.match(text, /0 bytes on disk/);
    assert.match(text, /lease: not observed/);
    await assert.rejects(fs.stat(path.join(agentDir, "pi-sync")), /ENOENT/);
  }));

test("Status reports retained candidate exhaustion separately from renewed window allowance", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    await store(config, (record) => {
      record.attempts[key] = 2;
      record.attempts[hashContinuous("spent-two")] = 2;
      record.attempts[hashContinuous("one-left")] = 1;
      record.phase = "blocked";
      record.error = "model";
      record.checked = 0;
      record.transferred = 0;
    });
    const text = await unchangedStatus(agentDir, config);
    assert.match(text, /0\/2 used; 2 remaining/);
    assert.match(text, /2 exhausted \/ 3 tracked/);
    assert.match(text, /Sync now reuses cached refusals/);
    assert.match(text, /separately confirmed retry/);
    assert.match(text, /1970-01-01T00:00:00.000Z/);
  }));

test("Status reports full serialized accounting without pruning candidates or granting requests", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    const { record, file } = await store(config);
    // Fill the canonical encoding, not a compact JSON approximation of the writer's capacity.
    for (let index = 0; index < 2000; index++) record.attempts[index.toString(16).padStart(64, "0")] = 2;
    while (Buffer.byteLength(serialize(record)) > CONTINUOUS_RECORD_MAX_BYTES)
      delete record.attempts[Object.keys(record.attempts).at(-1) as string];
    await fs.writeFile(file, serialize(record), { mode: 0o600 });
    const text = await unchangedStatus(agentDir, config);
    assert.match(text, /full for another reservation/);
    assert.match(text, /Next request eligibility: unavailable \(accounting full\)/);
    assert.match(text, /Do not delete accounting, prune candidates or reset limits/);
    assert.ok(text.includes(`${Buffer.byteLength(serialize(record))}/${CONTINUOUS_RECORD_MAX_BYTES}`));
  }));

for (const malformed of [
  "{broken-private-content",
  "null",
  JSON.stringify({ version: 99, privateEvidence: "retained-secret" }),
  " ".repeat(CONTINUOUS_RECORD_MAX_BYTES + 1),
]) {
  test(`Status preserves invalid or oversized accounting (${malformed.length} bytes)`, async () =>
    withTempHome(async (agentDir) => {
      const config = await configured(agentDir);
      const { file } = await store(config);
      await fs.writeFile(file, malformed, { mode: 0o600 });
      const text = await unchangedStatus(agentDir, config);
      assert.match(text, /private state unavailable/);
      assert.match(text, /cannot be verified/);
      assert.match(text, /do not treat unavailable accounting as unused allowance/);
      assert.doesNotMatch(text, /retained-secret|broken-private-content|2 remaining/);
    }));
}

test("Status preserves unknown fields and rejects terminal-control candidate IDs without disclosure", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    const { record, file } = await store(config);
    for (const invalid of [
      { ...record, futureEvidence: "unknown-private-evidence" },
      { ...record, attempts: { "\u001b[31mprivate-id\u0007\r\n": 2 } },
    ]) {
      await fs.writeFile(file, JSON.stringify(invalid), { mode: 0o600 });
      const text = await unchangedStatus(agentDir, config);
      assert.match(text, /private state unavailable/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Verify that private input cannot inject terminal controls.
      assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
      assert.doesNotMatch(text, /private-id|unknown-private-evidence/);
    }
  }));

for (const [kind, action] of [
  ["transient", /Wait for the scheduled retry/],
  ["contention", /Do not remove a live lock/],
  ["stale", /fresh inspection after the retry delay/],
  ["authentication", /Repair storage or Pi model authentication/],
  ["storage", /private-state permissions, free space or storage access/],
  ["unsafe", /Remove secrets or repair unsupported conflicts/],
  ["model", /Sync now reuses cached refusals/],
  ["budget", /Waiting does not restore exhausted candidates or accounting capacity/],
  ["unknown", /reconcile pending recovery before retrying/],
] as const) {
  test(`Status provides safe category-specific recovery for ${kind}`, async () =>
    withTempHome(async (agentDir) => {
      const config = await configured(agentDir);
      await store(config, (record) => {
        record.phase = "blocked";
        record.error = kind;
      });
      const text = await unchangedStatus(agentDir, config);
      assert.ok(text.includes(`Recovery (${kind}):`));
      assert.match(text, action);
      assert.doesNotMatch(text, /secret-key|access-key|Use Sync now for an explicit retry/);
    }));
}

for (const standby of [false, true]) {
  test(`Status reports ${standby ? "another setup's standby" : "another session's"} lease without guessing the owner model`, async () =>
    withTempHome(async (agentDir) => {
      const config = await configured(agentDir);
      const { binding } = await store(config);
      await fs.writeFile(
        path.join(continuousRoot(), "owner.json"),
        JSON.stringify({
          version: 1,
          binding: standby ? hashContinuous("another-setup") : binding,
          id: "12345678-1234-1234-1234-123456789abc",
          pid: 12345,
        }),
        { mode: 0o600 },
      );
      const guard = path.join(continuousRoot(), "scheduler.lock");
      await fs.mkdir(guard, { mode: 0o700 });
      const mtime = (await fs.lstat(guard)).mtimeMs;
      const text = await unchangedStatus(agentDir, config);
      assert.equal((await fs.lstat(guard)).mtimeMs, mtime);
      assert.match(text, /observed for pid 12345/);
      assert.match(text, standby ? /another setup; this setup is standby/ : /another session/);
      assert.match(text, /Scheduler owner model: unavailable/);
    }));
}

test("stale owner metadata is not proof of an elected scheduler", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    const { binding } = await store(config);
    await fs.writeFile(
      path.join(continuousRoot(), "owner.json"),
      JSON.stringify({ version: 1, binding, id: "12345678-1234-1234-1234-123456789abc", pid: 12345 }),
      { mode: 0o600 },
    );
    const guard = path.join(continuousRoot(), "scheduler.lock");
    await fs.mkdir(guard, { mode: 0o700 });
    await fs.utimes(guard, new Date(0), new Date(0));
    const text = await unchangedStatus(agentDir, config);
    assert.match(text, /lease: not observed/);
    assert.doesNotMatch(text, /pid 12345/);
    assert.equal((await fs.lstat(guard)).mtimeMs, 0);
  }));

test("invalid terminal-control owner IDs do not hide valid accounting or expose private metadata", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    const { binding } = await store(config);
    await fs.writeFile(
      path.join(continuousRoot(), "owner.json"),
      JSON.stringify({ version: 1, binding, id: "\u001b[31mprivate-owner\u0007", pid: 12345 }),
      { mode: 0o600 },
    );
    const text = await unchangedStatus(agentDir, config);
    assert.match(text, /owner metadata unavailable/);
    assert.match(text, /0\/2 used; 2 remaining/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Verify that corrupt owner metadata cannot inject terminal controls.
    assert.doesNotMatch(text, /private-owner|\u001b|\u0007/u);
  }));

test("Continuous diagnostics remain observable in RPC without requests or mutations", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    await store(config);
    const before = await tree(agentDir);
    const titles: string[] = [];
    const mock = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async (title: string) => {
        titles.push(title);
        return undefined;
      },
    });
    let routes = 0;
    await showSyncManager(mock.ctx, async () => {
      routes++;
      return { kind: "completed" };
    });
    assert.match(titles.join("\n"), /Automatic requests \(rolling 15 minutes/);
    assert.match(titles.join("\n"), /Accounting:/);
    assert.equal(routes, 0);
    assert.deepEqual(await tree(agentDir), before);
  }));

test("Continuous diagnostics keep the manager bounded at zero and narrow terminal widths", async () =>
  withTempHome(async (agentDir) => {
    const config = await configured(agentDir);
    await store(config, (record) => {
      record.phase = "blocked";
      record.error = "unknown";
    });
    const before = await tree(agentDir);
    for (const width of [1, 12, 32, 60]) {
      const tui = createTuiHarness({ width, rows: 16 });
      const zeroFrames: string[][] = [];
      // The harness requires positive terminal dimensions; exercise the component's zero-width contract directly.
      const custom: typeof tui.custom = (factory, options) =>
        tui.custom(async (...args) => {
          const component = await factory(...args);
          zeroFrames.push(component.render(0));
          return component;
        }, options);
      const mock = createMockContext({ mode: "tui", hasUI: true, custom });
      const running = showSyncManager(mock.ctx, async () => {
        assert.fail("rendering must not start a route");
      });
      try {
        await tui.waitForOpen();
        const frame = tui.render();
        assert.ok(frame.every((line) => visibleWidth(line) <= width));
        assert.ok(frame.length <= 16);
        tui.press("ctrl+c");
        await running;
        assert.ok(zeroFrames.length > 0);
        assert.ok(zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0)));
      } finally {
        tui.dispose();
      }
    }
    assert.deepEqual(await tree(agentDir), before);
  }));

for (const boundary of ["before queue", "inside update", "after atomic publication"] as const) {
  test(`reservation cancellation ${boundary} preserves the atomic accounting boundary`, async () =>
    withTempHome(async (agentDir) => {
      const config = await configured(agentDir);
      const binding = await continuousBinding(config);
      const lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      const controller = new AbortController();
      const file = path.join(continuousRoot(), `${binding}.json`);
      const originalRename = fs.rename;
      const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await originalRename(...args);
        if (boundary === "after atomic publication" && args[1] === file) controller.abort();
      });
      if (boundary === "before queue") controller.abort();
      try {
        await assert.rejects(
          reserveContinuousRequest(
            binding,
            lease,
            key,
            () => {
              if (boundary === "inside update") controller.abort();
              return now;
            },
            controller.signal,
          ),
          (error: unknown) => error instanceof DOMException && error.name === "AbortError",
        );
        const record = await readContinuousRecord(binding);
        assert.equal(record.attempts[key], boundary === "after atomic publication" ? 1 : undefined);
        assert.equal(record.calls.length, boundary === "after atomic publication" ? 1 : 0);
        if (boundary !== "after atomic publication") await assert.rejects(fs.stat(file), /ENOENT/);
      } finally {
        rename.mockRestore();
        await lease.release();
      }
    }));
}
