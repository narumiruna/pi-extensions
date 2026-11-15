import type { PiPane, RexQuery } from "../src/rex-snapshot.js";

export const sessionId = "session:00000000-0000-0000-0000-000000000001";
export const windowId = "window:00000000-0000-0000-0000-000000000002";
export const blockId = "block:00000000-0000-0000-0000-000000000003";
export const secondBlock = "block:00000000-0000-0000-0000-000000000004";
export const pane: PiPane = {
  sessionId,
  windowId,
  blockId,
  session: "Project",
  tab: "Code",
  pane: "Pi",
  cwd: "/home/user/src/project",
  home: "/home/user",
  state: "working",
  reported: true,
};

export function rexFixture() {
  const blocks = [blockId, secondBlock].map((block_id) => ({
    block_id,
    window_id: windowId,
    creator_name: "com.superlogical.terminal",
    placement: "placed",
    label: "Pi",
  }));
  const view = {
    session_id: sessionId,
    label: "Project",
    windows: [
      { window_id: windowId, label: "Code", layers: [{ blocks: [{ block_id: blockId }, { block_id: secondBlock }] }] },
    ],
  };
  const status: Record<string, unknown> = {
    [blockId]: { records: [{ app: "pi", state: "working" }] },
    [secondBlock]: { records: [{ app: "codex", state: "blocked" }] },
  };
  const process: Record<string, unknown> = {
    [blockId]: { foreground: { argv0: "pi", name: "node", cwd: pane.cwd }, home: pane.home },
    [secondBlock]: { foreground: { name: "node", argv0: "codex", cwd: "/other" } },
  };
  const calls: string[][] = [];
  const query: RexQuery = async (args, signal) => {
    signal.throwIfAborted();
    calls.push(args);
    if (args[0] === "ls") return { sessions: [{ session_id: sessionId }] };
    if (args[0] === "session") return view;
    if (args[1] === "ls") return { blocks };
    const id = args[5] ?? "";
    const value = args[6] === "program_status" ? status[id] : process[id];
    if (value instanceof Error) throw value;
    return value;
  };
  return { query, calls, blocks, view, status, process };
}
