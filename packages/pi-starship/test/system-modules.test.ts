import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { parseStyle } from "../src/format/style.js";
import { inspectStatuslineModules } from "../src/modules/inspection.js";
import { renderStatusline } from "../src/modules/render.js";
import { systemModules } from "../src/modules/system.js";
import type { StarshipRuntimeSnapshot, WorkspaceSnapshot } from "../src/modules/types.js";
import { AsyncRefreshController } from "../src/runtime/refresh-controller.js";
import type { WorkspaceExec, WorkspaceRefreshInput } from "../src/runtime/types.js";
import { collectWorkspaceSnapshot, workspaceSnapshotEqual } from "../src/runtime/workspace.js";

const native = vi.hoisted(() => ({ totalmem: vi.fn(() => 1_024 ** 3), freemem: vi.fn(() => 256 * 1_024 ** 2) }));
vi.mock("node:os", async (original) => ({ ...(await original<object>()), ...native }));
afterEach(() => vi.clearAllMocks());

const powerRoot = "/sys/class/power_supply";
const GiB = 1_024 ** 3;

// Threshold, percentage, aggregation, and merge branches follow Starship
// ae8fecf3 modules/{memory_usage,battery}.rs; native readers are Pi-specific.
function config(format = "$memory_usage$battery", overrides: Record<string, unknown> = {}) {
  return normalizeConfig({
    format,
    memory_usage: { disabled: false, threshold: 0 },
    battery: { disabled: false, display: [{ threshold: 100, style: "red bold", hidden: false }] },
    ...overrides,
  }).config;
}

function input(overrides: Partial<WorkspaceRefreshInput> = {}): WorkspaceRefreshInput {
  return {
    cwd: "/repo",
    config: config(),
    environment: {},
    homeDir: "/home/test",
    platform: "linux",
    hostname: "host",
    username: "user",
    systemMemory: () => ({ total: GiB, free: 256 * 1_024 ** 2 }),
    exec: async () => {
      throw new Error("native modules must not execute commands");
    },
    fileSystem: { readFile: async () => undefined, readDirectory: async () => [], fileExists: async () => false },
    ...overrides,
  };
}

function runtime(workspace: WorkspaceSnapshot): StarshipRuntimeSnapshot {
  return {
    cwd: "/repo",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(0),
    workspace,
  };
}

function uevent(fields: Record<string, string | number> = {}) {
  return `${Object.entries({
    TYPE: "Battery",
    PRESENT: 1,
    STATUS: "Discharging",
    ENERGY_NOW: 50,
    ENERGY_FULL: 100,
    ...fields,
  })
    .map(([key, value]) => `POWER_SUPPLY_${key}=${value}`)
    .join("\n")}\n`;
}

function batteries(sources: Record<string, string | undefined>) {
  const readDirectory = vi.fn(async (path: string) => {
    assert.equal(path, powerRoot);
    // sysfs exposes symlinks, not Dirent directories.
    return Object.keys(sources).map((name) => ({ name, isFile: false, isDirectory: false }));
  });
  const readFile = vi.fn(async (path: string, maxBytes: number) => {
    assert.equal(maxBytes, 8_192);
    return Object.entries(sources).find(([name]) => path === `${powerRoot}/${name}/uevent`)?.[1];
  });
  return { readDirectory, readFile };
}

async function batteryRender(sources: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  const fileSystem = batteries(sources);
  const settings = config("$battery", {
    battery: { disabled: false, display: [{ threshold: 100, style: "red bold", hidden: false }], ...options },
  });
  const snapshot = await collectWorkspaceSnapshot(input({ config: settings, fileSystem }));
  const rendered = renderStatusline(settings, runtime(snapshot));
  return { text: rendered.chunks.map((chunk) => chunk.text).join(""), rendered, snapshot, settings, fileSystem };
}

const batteryStates = ["Charging", "Discharging", "Full", "Empty", "Unknown"];
test.each(batteryStates.flatMap((a) => batteryStates.flatMap((b) => batteryStates.map((c) => [a, b, c]))))(
  "three-battery state aggregation is independent of device order: %s/%s/%s",
  async (a, b, c) => {
    const states = [a, b, c];
    const expected = states.includes("Charging")
      ? "charging"
      : states.includes("Discharging")
        ? "discharging"
        : states.includes("Full") && states.includes("Empty")
          ? "unknown"
          : states.includes("Full")
            ? "full"
            : states.includes("Empty")
              ? "empty"
              : "unknown";
    const result = await batteryRender({
      BAT2: uevent({ STATUS: a }),
      BAT0: uevent({ STATUS: b }),
      BAT1: uevent({ STATUS: c }),
    });
    assert.equal(result.snapshot.modules.battery?.state, expected);
    assert.equal(result.snapshot.modules.battery?.percentage, "50%");
  },
);

test("native modules default to disabled, stay out of default $all work, and do not sample unreachable data", async () => {
  for (const definition of systemModules) assert.equal(definition.defaults.disabled, true);
  const systemMemory = vi.fn(() => ({ total: GiB, free: 0 }));
  const readDirectory = vi.fn(async () => []);
  const readFile = vi.fn(async () => undefined);
  const exec = vi.fn<WorkspaceExec>();
  for (const settings of [normalizeConfig({ format: "$memory_usage$battery" }).config, config("static")]) {
    const snapshot = await collectWorkspaceSnapshot(
      input({ config: settings, systemMemory, fileSystem: { readDirectory, readFile }, exec }),
    );
    assert.deepEqual(snapshot.modules, {});
  }
  for (const name of ["memory_usage", "battery"] as const)
    assert.equal(normalizeConfig({ format: "$all" }).config.modules[name].disabled, true);
  expect(systemMemory).not.toHaveBeenCalled();
  expect(native.totalmem).not.toHaveBeenCalled();
  expect(native.freemem).not.toHaveBeenCalled();
  expect(readDirectory).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

test.each([
  [GiB, GiB, 0, "0B/1GiB", "0%"],
  [GiB, GiB / 2, 50, "512MiB/1GiB", "50%"],
  [GiB, 0, 100, "1GiB/1GiB", "100%"],
  [GiB, GiB * 2, 0, "0B/1GiB", "0%"],
  [1_536, 0, 0, "1KiB/1KiB", "100%"],
  [10_000, 2_550, 75, "7KiB/9KiB", "75%"],
])("native system memory totals/free=%i/%i threshold=%i", async (total, free, threshold, ram, ram_pct) => {
  const snapshot = await collectWorkspaceSnapshot(
    input({
      config: config("$memory_usage", { memory_usage: { disabled: false, threshold } }),
      systemMemory: () => ({ total, free }),
    }),
  );
  assert.deepEqual(snapshot.modules.memory_usage, { ram, ram_pct });
});

test.each([
  [{ total: 0, free: 0 }, 0],
  [{ total: -1, free: 0 }, 0],
  [{ total: Number.NaN, free: 0 }, 0],
  [{ total: Number.POSITIVE_INFINITY, free: 0 }, 0],
  [{ total: Number.MAX_SAFE_INTEGER + 1, free: 0 }, 0],
  [{ total: GiB, free: -1 }, 0],
  [{ total: GiB, free: Number.NaN }, 0],
  [{ total: GiB, free: 0 }, 9_999],
  [{ total: GiB, free: GiB }, 0.1],
])("memory rejects invalid data or unmet threshold: %j threshold=%s", async (systemMemory, threshold) => {
  const snapshot = await collectWorkspaceSnapshot(
    input({
      systemMemory: () => systemMemory,
      config: config("$memory_usage", { memory_usage: { disabled: false, threshold } }),
    }),
  );
  assert.deepEqual(snapshot.modules, {});
});

test("missing or failed native memory sources omit the module", async () => {
  for (const systemMemory of [
    () => undefined,
    () => {
      throw new Error("unavailable");
    },
  ]) {
    assert.deepEqual(
      (await collectWorkspaceSnapshot(input({ config: config("$memory_usage"), systemMemory }))).modules,
      {},
    );
  }
});

test("memory schema accepts finite fractional thresholds and preserves defaults for invalid values", () => {
  const good = normalizeConfig({ memory_usage: { disabled: false, threshold: 74.5 } });
  assert.equal(good.config.modules.memory_usage.options.threshold, 74.5);
  assert.deepEqual(good.diagnostics, []);
  for (const threshold of ["75", Number.NaN, Number.POSITIVE_INFINITY, -101, 10_001]) {
    const bad = normalizeConfig({ memory_usage: { threshold } });
    assert.equal(bad.config.modules.memory_usage.options.threshold, 75);
    assert.ok(bad.diagnostics.some((item) => item.path === "memory_usage.threshold"));
  }
});

test.each([
  [undefined, {}],
  [{ total: 0, free: 0 }, {}],
  [{ total: -1, free: 0 }, {}],
  [{ total: GiB, free: Number.NaN }, {}],
  [
    { total: GiB, free: GiB / 2 },
    { swap: "512MiB/1GiB", swap_pct: "50%" },
  ],
  [
    { total: GiB, free: GiB * 2 },
    { swap: "0B/1GiB", swap_pct: "0%" },
  ],
])("swap availability is explicit and zero/missing/invalid swap is absent: %j", async (swap, expected) => {
  const snapshot = await collectWorkspaceSnapshot(
    input({ config: config("$memory_usage"), systemMemory: () => ({ total: GiB, free: 0, swap }) }),
  );
  assert.deepEqual(snapshot.modules.memory_usage, { ram: "1GiB/1GiB", ram_pct: "100%", ...expected });
});

test("default sampling uses native os totals, and Linux swap has one bounded optional proc read", async () => {
  const readFile = vi.fn(async (path: string, maxBytes: number) => {
    assert.equal(path, "/proc/meminfo");
    assert.equal(maxBytes, 65_536);
    return "MemTotal: 100000 kB\nSwapTotal: 1048576 kB\nSwapFree: 524288 kB\n";
  });
  const snapshot = await collectWorkspaceSnapshot(
    input({ config: config("$memory_usage"), systemMemory: undefined, fileSystem: { readFile } }),
  );
  assert.deepEqual(snapshot.modules.memory_usage, {
    ram: "768MiB/1GiB",
    ram_pct: "75%",
    swap: "512MiB/1GiB",
    swap_pct: "50%",
  });
  expect(native.totalmem).toHaveBeenCalledTimes(1);
  expect(native.freemem).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledTimes(1);
});

test.each([
  undefined,
  "SwapTotal: broken kB\nSwapFree: 5 kB\n",
  "SwapTotal: 0 kB\nSwapFree: 0 kB\n",
  "SwapTotal: 12 MB\nSwapFree: 0 MB\n",
  "x".repeat(65_537),
])("unavailable, malformed and oversized swap sources preserve RAM data", async (source) => {
  const snapshot = await collectWorkspaceSnapshot(
    input({ config: config("$memory_usage"), systemMemory: undefined, fileSystem: { readFile: async () => source } }),
  );
  assert.deepEqual(snapshot.modules.memory_usage, { ram: "768MiB/1GiB", ram_pct: "75%" });
});

test("unused swap and unsupported swap platforms do not read proc metadata", async () => {
  const readFile = vi.fn(async () => undefined);
  for (const [platform, format] of [
    ["linux", "$ram_pct"],
    ["darwin", "$ram( | $swap)"],
    ["win32", "$swap_pct"],
  ] as const) {
    await collectWorkspaceSnapshot(
      input({
        platform,
        systemMemory: undefined,
        fileSystem: { readFile },
        config: config("$memory_usage", { memory_usage: { disabled: false, threshold: 0, format } }),
      }),
    );
  }
  expect(readFile).not.toHaveBeenCalled();
});

test.each([
  ["Charging", "charging", "󰂄 "],
  ["Discharging", "discharging", "󰂃 "],
  ["Full", "full", "󰁹 "],
  ["Empty", "empty", "󰂎 "],
  ["Unknown", "unknown", "󰂑 "],
  ["Not charging", "unknown", "󰂑 "],
  ["malformed", "unknown", "󰂑 "],
])("Linux battery state %s", async (STATUS, state, symbol) => {
  const result = await batteryRender({ BAT0: uevent({ STATUS }) });
  assert.equal(result.text, `${symbol}50% `);
  assert.equal(result.snapshot.modules.battery?.state, state);
});

test("battery aggregation weights energy and converts charge via voltage without capacity-only estimates", async () => {
  const charge =
    "POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_STATUS=Charging\nPOWER_SUPPLY_CHARGE_NOW=0\nPOWER_SUPPLY_CHARGE_FULL=300\nPOWER_SUPPLY_VOLTAGE_MIN_DESIGN=2000000\n";
  const result = await batteryRender({
    BAT1: charge,
    BAT0: uevent(),
    AC: uevent({ TYPE: "Mains" }),
    absent: uevent({ PRESENT: 0 }),
    malformed: "bad",
  });
  assert.equal(result.text, "󰂄 7% ");
  const voltageNow = charge.replace("VOLTAGE_MIN_DESIGN", "VOLTAGE_NOW");
  assert.equal((await batteryRender({ BAT0: voltageNow })).text, "󰂄 0% ");
  assert.equal((await batteryRender({ BAT0: "POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_CAPACITY=50\n" })).text, "");
});

const stateOrder = ["Unknown", "Charging", "Discharging", "Full", "Empty"] as const;
const mergedStates = [
  ["unknown", "charging", "discharging", "full", "empty"],
  ["charging", "charging", "charging", "charging", "charging"],
  ["discharging", "charging", "discharging", "discharging", "discharging"],
  ["full", "charging", "discharging", "full", "unknown"],
  ["empty", "charging", "discharging", "unknown", "empty"],
];
for (const [leftIndex, left] of stateOrder.entries()) {
  for (const [rightIndex, right] of stateOrder.entries()) {
    test(`multi-battery merge ${left}/${right}`, async () => {
      const result = await batteryRender({ BAT0: uevent({ STATUS: left }), BAT1: uevent({ STATUS: right }) });
      assert.equal(result.snapshot.modules.battery?.state, mergedStates[leftIndex]?.[rightIndex]);
    });
  }
}

test.each([
  [0, "0%"],
  [100, "100%"],
  [130, "100%"],
  [12.987654, "13%"],
])("battery percentages are rounded and bounded: %s", async (percentage, expected) => {
  const result = await batteryRender({
    BAT0: uevent({ ENERGY_NOW: Math.round(percentage * 1_000_000), ENERGY_FULL: 100_000_000 }),
  });
  assert.equal(result.snapshot.modules.battery?.percentage, expected);
});

test.each([
  {},
  { AC: uevent({ TYPE: "Mains" }) },
  { BAT0: uevent({ PRESENT: 0 }) },
  { BAT0: uevent({ ENERGY_FULL: 0 }) },
  { BAT0: uevent({ ENERGY_NOW: -1 }) },
  { BAT0: uevent({ ENERGY_NOW: "NaN" }) },
  { BAT0: uevent({ ENERGY_FULL: "Infinity" }) },
  { BAT0: "bad" },
  { BAT0: `${uevent()}POWER_SUPPLY_TYPE=Battery\n` },
  { BAT0: "x".repeat(8_193) },
  { BAT0: undefined },
  { "../BAT0": uevent() },
  { "\x1b[31mBAT0": uevent() },
])("missing and malformed battery sources are omitted: %j", async (sources) => {
  assert.equal((await batteryRender(sources)).text, "");
});

test.each(["darwin", "win32", "freebsd"] as const)(
  "battery unsupported platform %s performs no reads or commands",
  async (platform) => {
    const readDirectory = vi.fn(async () => []);
    const readFile = vi.fn(async () => undefined);
    const exec = vi.fn<WorkspaceExec>();
    const snapshot = await collectWorkspaceSnapshot(
      input({ config: config("$battery"), platform, fileSystem: { readDirectory, readFile }, exec }),
    );
    assert.deepEqual(snapshot.modules, {});
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  },
);

test("battery enumeration and source reads stay bounded, and failed reads stay unavailable", async () => {
  const sources = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`BAT${index}`, uevent()]));
  const fileSystem = batteries(sources);
  const snapshot = await collectWorkspaceSnapshot(input({ config: config("$battery"), fileSystem }));
  assert.deepEqual(snapshot.modules, {});
  expect(fileSystem.readFile).not.toHaveBeenCalled();
  for (const fs of [
    {
      readDirectory: async () => {
        throw new Error("unsupported");
      },
    },
    {
      ...batteries({ BAT0: undefined }),
      readFile: async () => {
        throw new Error("unavailable");
      },
    },
  ])
    assert.deepEqual(
      (await collectWorkspaceSnapshot(input({ config: config("$battery"), fileSystem: fs }))).modules,
      {},
    );
});

test("battery uses the lowest matching upper threshold independent of table order", async () => {
  for (const display of [
    [
      { threshold: 100, style: "blue", hidden: false },
      { threshold: 60, style: "bold green", hidden: false },
    ],
    [
      { threshold: 60, style: "bold green", hidden: false },
      { threshold: 100, style: "blue", hidden: false },
    ],
  ]) {
    const result = await batteryRender({ BAT0: uevent() }, { display });
    assert.deepEqual(result.rendered.chunks[0]?.style, parseStyle("bold green"));
  }
  assert.equal(
    (await batteryRender({ BAT0: uevent() }, { display: [{ threshold: 49.99, style: "red", hidden: false }] })).text,
    "",
  );
  assert.equal(
    (
      await batteryRender(
        { BAT0: uevent() },
        {
          display: [
            { threshold: 50, style: "red", hidden: true },
            { threshold: 100, style: "green", hidden: false },
          ],
        },
      )
    ).text,
    "",
  );
});

test("default battery threshold compares raw percentage, and symbols remain configurable and terminal-safe", async () => {
  for (const [ENERGY_NOW, visible] of [
    [999, true],
    [1_000, true],
    [1_001, false],
  ] as const) {
    const result = await batteryRender(
      { BAT0: uevent({ ENERGY_NOW, ENERGY_FULL: 10_000 }) },
      { display: [{ threshold: 10, style: "red bold", hidden: false }] },
    );
    assert.equal(result.text.length > 0, visible);
  }
  const custom = await batteryRender({ BAT0: uevent() }, { discharging_symbol: "\x1b[31mD\x1b[0m " });
  assert.equal(custom.text, "D 50% ");
  assert.equal((await batteryRender({ BAT0: uevent() }, { discharging_symbol: "" })).text, "50% ");
});

test("native snapshots have stable periodic equality and render/inspection performs zero sampling", async () => {
  const systemMemory = vi.fn(() => ({ total: GiB, free: GiB / 2 - 100 }));
  const settings = config();
  const fileSystem = batteries({ BAT0: uevent() });
  const first = await collectWorkspaceSnapshot(input({ config: settings, systemMemory, fileSystem }));
  const second = await collectWorkspaceSnapshot(
    input({ config: settings, systemMemory, fileSystem, reason: "periodic", previous: first }),
  );
  assert.equal(workspaceSnapshotEqual(first, second), true);
  const reads = fileSystem.readFile.mock.calls.length;
  const samples = systemMemory.mock.calls.length;
  for (const width of [0, 1, 40, 80]) {
    renderStatusline(settings, runtime(first), width);
    const inspection = inspectStatuslineModules(settings, runtime(first), width);
    assert.equal(inspection.modules.find((item) => item.name === "memory_usage")?.state, "Showing");
    assert.equal(inspection.modules.find((item) => item.name === "battery")?.state, "Showing");
  }
  assert.equal(fileSystem.readFile.mock.calls.length, reads);
  assert.equal(systemMemory.mock.calls.length, samples);
  assert.ok(Object.isFrozen(first.modules.memory_usage));
});

test("native cancellation prevents sampling before work and suppresses results after each awaited read", async () => {
  for (const phase of ["before", "directory", "read", "memory"] as const) {
    const controller = new AbortController();
    const fileSystem = batteries({ BAT0: uevent(), BAT1: uevent() });
    const systemMemory = vi.fn(() => {
      if (phase === "memory") controller.abort();
      return { total: GiB, free: 0 };
    });
    if (phase === "before") controller.abort();
    if (phase === "directory")
      fileSystem.readDirectory.mockImplementation(async () => {
        controller.abort();
        return [{ name: "BAT0", isDirectory: false, isFile: false }];
      });
    if (phase === "read")
      fileSystem.readFile.mockImplementation(async () => {
        controller.abort();
        return uevent();
      });
    const snapshot = await collectWorkspaceSnapshot(input({ systemMemory, fileSystem, signal: controller.signal }));
    assert.deepEqual(snapshot.modules, {});
    if (phase === "before") expect(systemMemory).not.toHaveBeenCalled();
    if (phase === "read") expect(fileSystem.readFile).toHaveBeenCalledTimes(1);
  }
});

test("session replacement and shutdown suppress a delayed native battery result", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const fileSystem = batteries({ BAT0: undefined });
  fileSystem.readFile.mockImplementation(async () => {
    ready();
    return pending;
  });
  const publish = vi.fn();
  let signal: AbortSignal | undefined;
  const controller = new AsyncRefreshController<WorkspaceRefreshInput, WorkspaceSnapshot>({
    read: (value, nextSignal) => {
      signal = nextSignal;
      return collectWorkspaceSnapshot({ ...value, signal });
    },
    equal: workspaceSnapshotEqual,
    publish,
  });
  controller.start(1);
  controller.request(input({ config: config("$battery"), fileSystem }));
  await started;
  controller.start(2);
  assert.equal(signal?.aborted, true);
  controller.stop();
  release(uevent());
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  expect(publish).not.toHaveBeenCalled();
});

test("native memory failure, default threshold and swap-only format use the same guarded reader", async () => {
  native.totalmem.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  assert.deepEqual(
    (await collectWorkspaceSnapshot(input({ config: config("$memory_usage"), systemMemory: undefined }))).modules,
    {},
  );
  const settings = normalizeConfig({ format: "$memory_usage", memory_usage: { disabled: false } }).config;
  for (const [free, visible] of [
    [2_600, false],
    [2_550, true],
    [2_500, true],
  ] as const) {
    const snapshot = await collectWorkspaceSnapshot(
      input({ config: settings, systemMemory: () => ({ total: 10_000, free }) }),
    );
    assert.equal(snapshot.modules.memory_usage !== undefined, visible);
  }
  const swapOnly = config("$memory_usage", { memory_usage: { disabled: false, threshold: 0, format: "$swap_pct" } });
  const snapshot = await collectWorkspaceSnapshot(
    input({ config: swapOnly, systemMemory: () => ({ total: GiB, free: 0, swap: { total: GiB, free: 0 } }) }),
  );
  assert.equal(
    renderStatusline(swapOnly, runtime(snapshot))
      .chunks.map((chunk) => chunk.text)
      .join(""),
    "100%",
  );
  const failed = await collectWorkspaceSnapshot(
    input({
      config: settings,
      systemMemory: undefined,
      fileSystem: {
        readFile: async () => {
          throw new Error("unavailable");
        },
      },
    }),
  );
  assert.deepEqual(failed.modules.memory_usage, { ram: "768MiB/1GiB", ram_pct: "75%" });
});

test("Linux battery fallback validates every charge/voltage input and optional presence field", async () => {
  const base =
    "POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_CHARGE_NOW=50\nPOWER_SUPPLY_CHARGE_FULL=100\nPOWER_SUPPLY_VOLTAGE_NOW=1000000\n";
  assert.equal((await batteryRender({ BAT0: base })).text, "󰂑 50% ");
  for (const source of [
    base.replace("POWER_SUPPLY_CHARGE_NOW=50\n", ""),
    base.replace("POWER_SUPPLY_CHARGE_FULL=100\n", ""),
    base.replace("POWER_SUPPLY_VOLTAGE_NOW=1000000\n", ""),
    base.replace("CHARGE_NOW=50", "CHARGE_NOW=1.5"),
    base.replace("CHARGE_FULL=100", "CHARGE_FULL=0"),
    base.replace("VOLTAGE_NOW=1000000", "VOLTAGE_NOW=0"),
    base.replace("VOLTAGE_NOW=1000000", "VOLTAGE_NOW=9007199254740992"),
    `${base}POWER_SUPPLY_PRESENT=unknown\n`,
    `${base}unrecognized=value\n`,
    `${base}no-separator\n`,
  ])
    assert.equal((await batteryRender({ BAT0: source })).text, "");
});

test("Linux battery cap is inclusive, tie thresholds choose first, and mixed full/empty state stays unknown", async () => {
  const sources = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`BAT${index}`, uevent()]));
  const result = await batteryRender(sources);
  expect(result.fileSystem.readFile).toHaveBeenCalledTimes(32);
  assert.equal(result.text, "󰂃 50% ");
  const tied = await batteryRender(
    { BAT0: uevent() },
    {
      display: [
        { threshold: 100, style: "blue", hidden: false },
        { threshold: 100, style: "red", hidden: false },
      ],
    },
  );
  assert.deepEqual(tied.rendered.chunks[0]?.style, parseStyle("blue"));
  const order = await batteryRender({
    BAT2: uevent({ STATUS: "Full" }),
    BAT1: uevent({ STATUS: "Empty" }),
    BAT0: uevent({ STATUS: "Full" }),
  });
  assert.equal(order.snapshot.modules.battery?.state, "unknown");
  const overflow = await batteryRender({
    BAT0: uevent({ ENERGY_FULL: Number.MAX_SAFE_INTEGER }),
    BAT1: uevent({ ENERGY_FULL: Number.MAX_SAFE_INTEGER }),
  });
  assert.equal(overflow.text, "");
});
