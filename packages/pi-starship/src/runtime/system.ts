import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { MAX_METADATA_FILE_BYTES, optionNumber } from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

const POWER_SUPPLY_ROOT = "/sys/class/power_supply";
const MAX_POWER_SUPPLIES = 32;
const MAX_UEVENT_BYTES = 8_192;

type BatteryState = "charging" | "discharging" | "full" | "empty" | "unknown";
interface MemoryStats {
  total: number;
  free: number;
  swap?: { total: number; free: number };
}
interface BatteryStats {
  energy: number;
  full: number;
  state: BatteryState;
}

export async function collectSystem(context: CollectorContext): Promise<MutableModuleSnapshot> {
  const modules: MutableModuleSnapshot = {};
  if (context.input.signal?.aborted) return modules;
  if (context.needs("memory_usage")) {
    const values = await collectMemory(context);
    if (context.input.signal?.aborted) return {};
    if (values) modules.memory_usage = values;
  }
  if (context.needs("battery")) {
    const values = await collectBattery(context);
    if (context.input.signal?.aborted) return {};
    if (values) modules.battery = values;
  }
  return modules;
}

async function collectMemory(context: CollectorContext): Promise<Record<string, string> | undefined> {
  let stats: MemoryStats | undefined;
  const injected = context.input.systemMemory;
  try {
    // The injection is a test seam, not an extension setting. No sample is taken
    // before reachability and cancellation checks in collectSystem().
    stats = injected ? injected() : { total: totalmem(), free: freemem() };
  } catch {
    return undefined;
  }
  if (!stats || !validTotal(stats.total) || !validBytes(stats.free)) return undefined;
  const used = Math.max(0, stats.total - stats.free);
  const percentage = Math.round(100 * (used / stats.total));
  if (percentage < (optionNumber(context, "memory_usage", "threshold") ?? 75)) return undefined;
  const values: Record<string, string> = { ram: formatUsage(stats.total, stats.free), ram_pct: `${percentage}%` };
  if (context.needs("memory_usage", "swap") || context.needs("memory_usage", "swap_pct")) {
    // Node's native os API has no swap data. Linux can supply it through this
    // bounded read; other platforms (or missing/malformed sources) omit swap.
    const swap =
      stats.swap ??
      (injected === undefined && context.input.platform === "linux"
        ? parseSwap(await readBounded(context, "/proc/meminfo", MAX_METADATA_FILE_BYTES))
        : undefined);
    if (context.input.signal?.aborted) return undefined;
    if (swap && validTotal(swap.total) && validBytes(swap.free)) {
      values.swap = formatUsage(swap.total, swap.free);
      values.swap_pct = `${Math.round(100 * (Math.max(0, swap.total - swap.free) / swap.total))}%`;
    }
  }
  return values;
}

function validBytes(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function validTotal(value: number): boolean {
  return validBytes(value) && value > 0;
}

function formatUsage(total: number, free: number): string {
  return `${formatBytes(Math.max(0, total - free))}/${formatBytes(total)}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${Math.floor(value)}${units[unit]}`;
}

function parseSwap(source: string | undefined): MemoryStats["swap"] {
  if (source === undefined) return undefined;
  const total = /^SwapTotal:\s+([0-9]+) kB\s*$/mu.exec(source)?.[1];
  const free = /^SwapFree:\s+([0-9]+) kB\s*$/mu.exec(source)?.[1];
  if (total === undefined || free === undefined) return undefined;
  const stats = { total: Number(total) * 1_024, free: Number(free) * 1_024 };
  return validTotal(stats.total) && validBytes(stats.free) ? stats : undefined;
}

async function collectBattery(context: CollectorContext): Promise<Record<string, string> | undefined> {
  // Linux sysfs only. Do not probe another platform with external commands.
  if (context.input.platform !== "linux" || context.input.signal?.aborted) return undefined;
  let entries: Awaited<ReturnType<CollectorContext["fs"]["readDirectory"]>>;
  try {
    entries = await context.fs.readDirectory(POWER_SUPPLY_ROOT);
  } catch {
    return undefined;
  }
  if (context.input.signal?.aborted || entries.length > MAX_POWER_SUPPLIES) return undefined;
  let energy = 0;
  let full = 0;
  const states = new Set<BatteryState>();
  for (const entry of [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    // Reject names rather than normalize them into another filesystem path.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(entry.name)) continue;
    const source = await readBounded(context, join(POWER_SUPPLY_ROOT, entry.name, "uevent"), MAX_UEVENT_BYTES);
    if (context.input.signal?.aborted) return undefined;
    const battery = parseBattery(source);
    if (!battery) continue;
    energy += battery.energy;
    full += battery.full;
    states.add(battery.state);
  }
  if (!validTotal(full) || !validBytes(energy)) return undefined;
  const percentage = Math.min(100, Math.max(0, 100 * (energy / full)));
  return {
    percentage: `${Math.round(percentage)}%`,
    percentage_raw: String(percentage),
    state: mergeBatteryStates(states),
  };
}

function parseBattery(source: string | undefined): BatteryStats | undefined {
  if (source === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator);
    if (!/^POWER_SUPPLY_[A-Z0-9_]+$/u.test(key) || fields.has(key)) return undefined;
    fields.set(key, line.slice(separator + 1));
  }
  const present = fields.get("POWER_SUPPLY_PRESENT");
  if (fields.get("POWER_SUPPLY_TYPE") !== "Battery" || (present !== undefined && present !== "1")) return undefined;
  const number = (key: string) => {
    const raw = fields.get(`POWER_SUPPLY_${key}`);
    if (raw === undefined || !/^[0-9]+$/u.test(raw)) return undefined;
    const value = Number(raw);
    return validBytes(value) ? value : undefined;
  };
  let energy = number("ENERGY_NOW");
  let full = number("ENERGY_FULL");
  if (energy === undefined || full === undefined) {
    const charge = number("CHARGE_NOW");
    const chargeFull = number("CHARGE_FULL");
    const voltage = number("VOLTAGE_MIN_DESIGN") ?? number("VOLTAGE_NOW");
    if (charge === undefined || chargeFull === undefined || voltage === undefined || voltage <= 0) return undefined;
    // Both branches use micro-watt-hours so different battery types can be weighted together.
    energy = charge * (voltage / 1_000_000);
    full = chargeFull * (voltage / 1_000_000);
  }
  if (!validTotal(full) || !validBytes(energy)) return undefined;
  const rawState = fields.get("POWER_SUPPLY_STATUS");
  const state =
    rawState === "Charging"
      ? "charging"
      : rawState === "Discharging"
        ? "discharging"
        : rawState === "Full"
          ? "full"
          : rawState === "Empty"
            ? "empty"
            : "unknown";
  return { energy: Math.min(full, energy), full, state };
}

function mergeBatteryStates(states: ReadonlySet<BatteryState>): BatteryState {
  if (states.has("charging")) return "charging";
  if (states.has("discharging")) return "discharging";
  // An ambiguous full/empty combination must remain unknown even when a later
  // battery is full; aggregation must not depend on power-supply naming order.
  if (states.has("full") && states.has("empty")) return "unknown";
  if (states.has("full")) return "full";
  if (states.has("empty")) return "empty";
  return "unknown";
}

async function readBounded(context: CollectorContext, path: string, maxBytes: number): Promise<string | undefined> {
  if (context.input.signal?.aborted) return undefined;
  try {
    const source = await context.fs.readFile(path, maxBytes);
    return !context.input.signal?.aborted && source !== undefined && Buffer.byteLength(source) <= maxBytes
      ? source
      : undefined;
  } catch {
    return undefined;
  }
}
