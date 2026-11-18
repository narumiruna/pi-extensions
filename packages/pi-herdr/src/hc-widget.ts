import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  type HerdrWidgetRow,
  type HerdrWidgetSnapshot,
  type HerdrWidgetState,
  MAX_HERDR_WIDGET_AGENTS,
} from "./herdr-widget.js";

/** Public terminal facts only; no legacy pane/session identity is synthesized. */
export interface HcTerminal {
  address: string;
  created_ms: number;
  argv: readonly string[];
  cwd: string;
  state: "live" | "finished";
  labels: Readonly<Record<string, string>>;
  name?: string | null;
  parent?: string | null;
  status?: { state: string; app?: string } | null;
  reported: boolean;
}

const STATE_ORDER: Record<HerdrWidgetState, number> = {
  error: -1,
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** Validate the public fields used here, without changing or retaining opaque payloads. */
export function parseHcTerminal(value: unknown): HcTerminal | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.address !== "string" ||
    !safeDisplay(value.address) ||
    typeof value.created_ms !== "number" ||
    !Number.isSafeInteger(value.created_ms) ||
    value.created_ms < 0 ||
    !stringArray(value.argv) ||
    typeof value.cwd !== "string" ||
    (value.state !== "live" && value.state !== "finished") ||
    !isRecord(value.labels) ||
    !Object.values(value.labels).every((label) => typeof label === "string") ||
    !optionalString(value.name) ||
    !optionalString(value.parent) ||
    (value.reported !== undefined && typeof value.reported !== "boolean")
  ) {
    return undefined;
  }
  let status: HcTerminal["status"];
  if (value.status === null || value.status === undefined) {
    status = value.status;
  } else {
    if (
      !isRecord(value.status) ||
      typeof value.status.state !== "string" ||
      (value.status.app !== undefined && typeof value.status.app !== "string")
    ) {
      return undefined;
    }
    // Titles, messages, and secondary OSC records are not widget content.
    status = {
      state: value.status.state,
      ...(value.status.app === undefined ? {} : { app: value.status.app }),
    };
  }
  return {
    address: value.address,
    created_ms: value.created_ms,
    argv: [...value.argv],
    cwd: value.cwd,
    state: value.state,
    labels: { ...value.labels } as Record<string, string>,
    name: value.name,
    parent: value.parent,
    status,
    reported: value.reported ?? false,
  };
}

/** Reject an invalid authoritative snapshot rather than reviving a partial identity graph. */
export function parseHcTerminals(value: unknown): HcTerminal[] {
  if (!Array.isArray(value)) throw new Error("hc returned an invalid terminal list");
  return value.map((record: unknown) => {
    const terminal = parseHcTerminal(record);
    if (!terminal) throw new Error("hc returned an invalid terminal record");
    return terminal;
  });
}

function safeDisplay(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const safe = sanitizeTerminalText(value).trim();
  return safe || undefined;
}

interface DisplayTerminal {
  terminal: HcTerminal;
  address: string;
  parent?: string;
  name?: string;
  app?: string;
  cwd?: string;
  state: HerdrWidgetState;
}

function displayTerminal(terminal: HcTerminal): DisplayTerminal | undefined {
  const address = safeDisplay(terminal.address);
  const parent = safeDisplay(terminal.parent);
  const name = safeDisplay(terminal.name);
  const app = safeDisplay(terminal.status?.app);
  const cwd = safeDisplay(terminal.cwd);
  const word = terminal.status?.state;
  // Exact public words determine state; sanitizing an unknown word must not turn it into a known state.
  const state = word && Object.hasOwn(STATE_ORDER, word) ? (word as HerdrWidgetState) : "unknown";
  return address ? { terminal, address, parent, name, app, cwd, state } : undefined;
}

function terminalSpace(terminal: DisplayTerminal): string {
  // Public mirror addresses are already localized by hc, including parent refs.
  // Never strip a parent prefix or guess a namespace from its child's address.
  const machine = terminal.address.includes("/") ? terminal.address.split("/")[0] : undefined;
  const fallback = machine || "local";
  const cwd = terminal.cwd;
  if (!cwd || /^[a-z]:[\\/]*$/iu.test(cwd)) return fallback;
  return (
    cwd
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || fallback
  );
}

function originDisplay(origin: DisplayTerminal): string {
  const label = origin.name ?? origin.app;
  return label ? `${label}/${origin.address}` : origin.address;
}

/**
 * Pure projection of a complete public snapshot. Ancestry belongs to terminals,
 * survives kept-program replacement, and never identifies a Pi session/program.
 */
export function createHcWidgetSnapshot(
  terminals: readonly HcTerminal[],
  currentAddress: string,
): HerdrWidgetSnapshot | undefined {
  // Sanitize all presentation fields before filtering, path splitting, or sorting.
  // Raw addresses remain separate: sanitization must not create identity matches.
  const displayed = terminals.flatMap((terminal) => {
    const display = displayTerminal(terminal);
    return display ? [display] : [];
  });
  const addressCounts = new Map<string, number>();
  const displayCounts = new Map<string, number>();
  for (const entry of displayed) {
    addressCounts.set(entry.terminal.address, (addressCounts.get(entry.terminal.address) ?? 0) + 1);
    displayCounts.set(entry.address, (displayCounts.get(entry.address) ?? 0) + 1);
  }
  const ambiguous = new Set<string>();
  const graph = new Map<string, DisplayTerminal>();
  for (const entry of displayed) {
    if (addressCounts.get(entry.terminal.address) !== 1 || displayCounts.get(entry.address) !== 1) {
      ambiguous.add(entry.terminal.address);
    } else {
      graph.set(entry.terminal.address, entry);
    }
  }

  const validity = new Map<string, boolean>();
  const validAncestry = (address: string): boolean => {
    const path: string[] = [];
    const visited = new Set<string>();
    let next: string | null | undefined = address;
    let valid = true;
    while (next !== undefined && next !== null) {
      const cached = validity.get(next);
      if (cached !== undefined) {
        valid = cached;
        break;
      }
      if (ambiguous.has(next) || visited.has(next)) {
        valid = false;
        break;
      }
      visited.add(next);
      path.push(next);
      next = graph.get(next)?.terminal.parent;
    }
    for (const identity of path) validity.set(identity, valid);
    return valid;
  };

  const current = graph.get(currentAddress);
  const currentOrigin = current && validAncestry(currentAddress) ? current.terminal.parent : undefined;
  const rows: HerdrWidgetRow[] = [];
  // Resolve from the full graph, including self, finished/unreported terminals,
  // and parents that will not fit within the five visible rows.
  for (const entry of graph.values()) {
    const terminal = entry.terminal;
    if (terminal.address === currentAddress || terminal.state !== "live" || !terminal.reported || !entry.app) continue;
    const labels: string[] = [];
    if (entry.parent && terminal.parent && validAncestry(terminal.address)) {
      const origin = graph.get(terminal.parent);
      const label = origin ? (origin === current ? "you" : originDisplay(origin)) : `${entry.parent} (unavailable)`;
      labels.push(`terminal spawned by ${label}`);
    }
    if (currentOrigin === terminal.address) labels.push("spawned your terminal");
    rows.push({
      agent: entry.name ?? entry.app,
      pane: entry.address,
      paneId: entry.address,
      space: terminalSpace(entry),
      state: entry.state,
      stateLabel: entry.state,
      ...(labels.length > 0 ? { relation: labels.join("; ") } : {}),
    });
  }
  rows.sort(
    (left, right) =>
      STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
      left.agent.localeCompare(right.agent) ||
      left.pane.localeCompare(right.pane) ||
      left.paneId.localeCompare(right.paneId),
  );
  if (rows.length === 0) return undefined;
  const visible = rows.slice(0, MAX_HERDR_WIDGET_AGENTS).map((row) => Object.freeze(row));
  return Object.freeze({
    totalAgents: rows.length,
    hiddenAgents: rows.length - visible.length,
    rows: Object.freeze(visible),
  });
}
