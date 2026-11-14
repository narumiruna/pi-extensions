import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATES = ["blocked", "error", "done", "working", "idle"] as const;
export type RexState = (typeof STATES)[number];

export interface PiPane {
  sessionId: string;
  windowId: string;
  blockId: string;
  session: string;
  tab: string;
  pane: string;
  state: RexState;
  reported: boolean;
  cwd?: string;
  home?: string;
}

export interface RexSnapshot {
  entries: PiPane[];
  warnings: string[];
}

type RecordValue = Record<string, unknown>;
export type RexQuery = (args: string[], signal: AbortSignal) => Promise<unknown>;

export function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rex object");
  return value as RecordValue;
}

function list(value: unknown, key: string, limit = 4096): RecordValue[] {
  const items = object(value)[key];
  if (!Array.isArray(items) || items.length > limit) throw new Error(`Invalid Rex ${key} array`);
  return items.map(object);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function id(value: unknown, kind: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${kind}:[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}$`, "iu").test(value)
  ) {
    throw new Error(`Missing or invalid Rex ${kind} ID`);
  }
  return value;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRexQuery(exec: ExtensionAPI["exec"]): RexQuery {
  return async (args, signal) => {
    signal.throwIfAborted();
    const result = await exec("rex", ["--autostart=false", "--timeout", "3s", "--color", "never", ...args], {
      signal,
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    signal.throwIfAborted();
    if (result.truncated) throw new Error("Rex response exceeded 1 MiB");
    if (result.killed) throw new Error("Rex request timed out or was cancelled");
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Rex exited with code ${result.code}`);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("Invalid JSON from Rex");
    }
  };
}

/** One Pi row per pane. Rex's effective_app wins; older responses can inherit app from ancestors. */
export function piStatus(value: unknown): RexState | undefined {
  const records = list(value, "records", 256);
  const parents = new Map<string, RecordValue | null>();
  for (const record of records) {
    const key = text(record.id) ?? "";
    parents.set(key, parents.has(key) ? null : record);
  }
  let state: RexState | undefined;
  for (const record of records) {
    if (record.state === "clear") continue;
    let app = text(record.effective_app) ?? text(record.app);
    let key = text(record.id) ?? "";
    if (app === undefined && key.length <= 128) {
      while (key && app === undefined) {
        key = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
        const parent = parents.get(key);
        if (parent === null) break;
        app = text(parent?.app);
      }
    }
    if (app !== "pi") continue;
    // The installed Rex program_status output schema specifies idle for unknown states.
    const next = STATES.find((candidate) => candidate === record.state) ?? "idle";
    if (state === undefined || STATES.indexOf(next) < STATES.indexOf(state)) state = next;
  }
  return state;
}

function foregroundPi(value: RecordValue): boolean {
  const foreground = value.foreground;
  if (foreground === null || foreground === undefined) return false;
  const process = object(foreground);
  return [process.script, process.argv0, process.name].some((value) => text(value)?.split("/").at(-1) === "pi");
}

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !value.includes("\0")
    ? value
    : undefined;
}

/** Read only the connected server. No app selection, focus changes, or terminal scraping. */
export async function readRexSnapshot(query: RexQuery, signal: AbortSignal): Promise<RexSnapshot> {
  const sessions = list(await query(["ls", "--json"], signal), "sessions");
  signal.throwIfAborted();
  const snapshot: RexSnapshot = { entries: [], warnings: [] };
  const seenSessions = new Set<string>();
  for (const session of sessions) {
    signal.throwIfAborted();
    const sessionId = id(session.session_id, "session");
    if (seenSessions.has(sessionId)) throw new Error("Duplicate Rex session ID");
    seenSessions.add(sessionId);
    try {
      const blocks = list(await query(["block", "ls", "-s", sessionId, "--json"], signal), "blocks");
      signal.throwIfAborted();
      const view = object(await query(["session", "inspect", sessionId, "--json"], signal));
      signal.throwIfAborted();
      if (view.session_id !== sessionId) throw new Error("Rex returned a different session");
      const locations = new Map<string, { windowId: string; tab: string }>();
      const ambiguous = new Set<string>();
      for (const [index, window] of list(view, "windows").entries()) {
        const windowId = id(window.window_id, "window");
        const defaultLabel = `Window ${windowId.slice(-8)}`;
        const tab = text(window.label) && window.label !== defaultLabel ? String(window.label) : `Tab ${index + 1}`;
        for (const layer of list(window, "layers")) {
          for (const block of list(layer, "blocks")) {
            const blockId = id(block.block_id, "block");
            if (locations.has(blockId)) ambiguous.add(blockId);
            locations.set(blockId, { windowId, tab });
          }
        }
      }
      const seenBlocks = new Set<string>();
      for (const block of blocks) {
        const blockId = id(block.block_id, "block");
        if (seenBlocks.has(blockId)) ambiguous.add(blockId);
        seenBlocks.add(blockId);
      }
      for (const block of blocks) {
        signal.throwIfAborted();
        if (block.creator_name !== "com.superlogical.terminal") continue;
        const blockId = id(block.block_id, "block");
        const location = locations.get(blockId);
        if (
          block.placement !== "placed" ||
          !location ||
          block.window_id !== location.windowId ||
          ambiguous.has(blockId)
        ) {
          snapshot.warnings.push("Detached, moved, or ambiguous terminal pane ignored");
          continue;
        }
        const args = ["block", "call", "-s", sessionId, "-b", blockId];
        let state: RexState | undefined;
        let statusFailed = false;
        try {
          state = piStatus(await query([...args, "program_status"], signal));
        } catch (error) {
          signal.throwIfAborted();
          statusFailed = true;
          snapshot.warnings.push(`Status unavailable: ${errorText(error)}`);
        }
        signal.throwIfAborted();
        let process: RecordValue = {};
        let isPi = false;
        try {
          process = object(await query([...args, "process"], signal));
          signal.throwIfAborted();
          isPi = foregroundPi(process);
        } catch (error) {
          signal.throwIfAborted();
          snapshot.warnings.push(`Process unavailable: ${errorText(error)}`);
        }
        const reported = state !== undefined;
        // Failed status is not a reported idle state. The snapshot remains explicitly partial.
        if (!reported && (!isPi || statusFailed)) continue;
        const foreground = isPi ? object(process.foreground) : {};
        snapshot.entries.push({
          sessionId,
          blockId,
          ...location,
          session: text(view.label) || sessionId,
          pane: text(block.label) || blockId,
          state: state ?? "idle",
          reported,
          cwd: absolutePath(foreground.cwd),
          home: absolutePath(process.home),
        });
      }
    } catch (error) {
      signal.throwIfAborted();
      snapshot.warnings.push(`Session unavailable: ${errorText(error)}`);
    }
  }
  return snapshot;
}
