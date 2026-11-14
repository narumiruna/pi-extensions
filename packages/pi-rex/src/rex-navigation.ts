import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  errorText,
  foregroundPi,
  id,
  list,
  object,
  type PiPane,
  piStatus,
  type RexCommand,
  type RexQuery,
} from "./rex-snapshot.js";

type Select = ExtensionContext["ui"]["select"];

export function paneChoice(entry: PiPane, index: number): string {
  return `${index + 1}. ${[entry.session, entry.tab, entry.pane, entry.cwd ?? "CWD unavailable"].map(sanitizeTerminalText).join(" / ")}`;
}

async function apps(query: RexQuery, signal: AbortSignal) {
  const value = await query(["client", "ls", "--json"], signal);
  signal.throwIfAborted();
  const seen = new Set<string>();
  return list(value, "clients").flatMap((client) => {
    const info = client.info;
    if (
      !info ||
      typeof info !== "object" ||
      Array.isArray(info) ||
      object(info).kind !== "app" ||
      client.connection_state !== "connected"
    )
      return [];
    const clientId = id(client.client_id, "client");
    if (seen.has(clientId)) throw new Error("Ambiguous Rex app client ID");
    seen.add(clientId);
    const label = object(info).label;
    return [{ id: clientId, label: sanitizeTerminalText(typeof label === "string" ? label : "Rex app") }];
  });
}

async function validateTarget(query: RexQuery, target: PiPane, signal: AbortSignal, focused = false) {
  const inspected = object(await query(["block", "inspect", "-s", target.sessionId, target.blockId, "--json"], signal));
  signal.throwIfAborted();
  const block = object(inspected.block);
  if (
    inspected.session_id !== target.sessionId ||
    block.block_id !== target.blockId ||
    block.window_id !== target.windowId ||
    block.placement !== "placed" ||
    block.creator_name !== "com.superlogical.terminal"
  ) {
    throw new Error("Rex pane closed, moved, or changed");
  }
  const view = object(await query(["session", "inspect", target.sessionId, "--json"], signal));
  signal.throwIfAborted();
  let matches = 0;
  for (const window of list(view, "windows")) {
    for (const layer of list(window, "layers")) {
      for (const pane of list(layer, "blocks")) {
        if (pane.block_id !== target.blockId) continue;
        if (
          window.window_id !== target.windowId ||
          (focused && (view.active_window_id !== target.windowId || window.focused_block_id !== target.blockId))
        )
          throw new Error("Rex pane location or focus changed concurrently");
        matches++;
      }
    }
  }
  if (view.session_id !== target.sessionId || matches !== 1)
    throw new Error("Rex pane location is missing or ambiguous");
  const args = ["block", "call", "-s", target.sessionId, "-b", target.blockId];
  const status = await query([...args, "program_status"], signal);
  signal.throwIfAborted();
  if (piStatus(status) !== undefined) return;
  const process = object(await query([...args, "process"], signal));
  signal.throwIfAborted();
  if (!foregroundPi(process)) throw new Error("Pi is no longer present in the selected Rex pane");
}

function supportsSelection(value: unknown): boolean {
  return list(value, "actions").some((action) => {
    if (action.name !== "session.select") return false;
    const args = object(action.args);
    const properties = object(args.properties);
    const required = args.required;
    return (
      args.type === "object" &&
      object(properties.session_id).type === "string" &&
      object(properties.window_id).type === "string" &&
      (required === undefined ||
        (Array.isArray(required) && required.every((key) => key === "session_id" || key === "window_id")))
    );
  });
}

/** Navigation never substitutes a client or retries a mutation, including after timeout. */
export async function navigateRexPane(
  query: RexQuery,
  run: RexCommand,
  target: PiPane,
  select: Select,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  id(target.sessionId, "session");
  id(target.windowId, "window");
  id(target.blockId, "block");
  const connected = await apps(query, signal);
  signal.throwIfAborted();
  if (!connected.length) throw new Error("No connected Rex app");
  let client = connected.length === 1 ? connected[0] : undefined;
  if (!client) {
    const labels = connected.map((app, index) => `${index + 1}. ${app.label} · ${app.id}`);
    const choice = await select("Switch in which Rex app?", labels, { signal });
    signal.throwIfAborted();
    if (choice === undefined) return;
    client = connected[labels.indexOf(choice)];
    if (!client) throw new Error("Invalid Rex app selection");
  }
  const actions = await query(["-C", client.id, "actions", "--json"], signal);
  signal.throwIfAborted();
  if (!supportsSelection(actions)) throw new Error("Rex app does not support session.select with window_id");
  await validateTarget(query, target, signal);
  signal.throwIfAborted();
  const ensureClient = async () => {
    const current = await apps(query, signal);
    signal.throwIfAborted();
    if (!current.some((app) => app.id === client.id))
      throw new Error("The selected Rex app disconnected; no other app will be used");
  };
  await ensureClient();
  signal.throwIfAborted();
  // Once this is sent, cancellation cannot undo shared server focus.
  try {
    await run(["focus", "-s", target.sessionId, target.blockId], signal);
    signal.throwIfAborted();
    await validateTarget(query, target, signal, true);
    signal.throwIfAborted();
    await ensureClient();
    signal.throwIfAborted();
    await run(
      ["-C", client.id, "do", "session.select", `session_id=${target.sessionId}`, `window_id=${target.windowId}`],
      signal,
    );
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `Rex server focus may have changed. App selection may be incomplete; check Remote Control. No automatic retry: ${errorText(error)}`,
    );
  }
}
