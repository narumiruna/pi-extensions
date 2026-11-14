import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { navigateRexPane } from "../src/rex-navigation.js";
import type { RexCommand, RexQuery } from "../src/rex-snapshot.js";
import { blockId, pane, rexFixture, sessionId, windowId } from "./fixtures.js";

type Select = ExtensionContext["ui"]["select"];
export const clientId = "client:00000000-0000-0000-0000-000000000010";
export const otherClient = "client:00000000-0000-0000-0000-000000000011";

export function navigationFixture() {
  const fixture = rexFixture();
  const connected = (client_id: string, label = "App") => ({
    client_id,
    connection_state: "connected",
    info: { kind: "app", label },
  });
  const model = {
    clients: [connected(clientId)] as Record<string, unknown>[],
    actions: {
      actions: [
        {
          name: "session.select",
          args: {
            type: "object",
            properties: { session_id: { type: "string" }, window_id: { type: "string" } },
            required: ["session_id"],
          },
        },
      ],
    } as unknown,
    inspected: { session_id: sessionId, block: fixture.blocks[0] } as Record<string, unknown>,
    focused: false,
  };
  const mutations: string[][] = [];
  const queries: string[][] = [];
  const select = vi.fn<Select>().mockImplementation(async (_title, labels) => labels[0]);
  const query = vi.fn<RexQuery>().mockImplementation(async (args, signal) => {
    signal.throwIfAborted();
    queries.push(args);
    if (args[0] === "client") return { clients: model.clients };
    if (args[0] === "-C") return model.actions;
    if (args[1] === "inspect" && args[0] === "block") return model.inspected;
    if (args[0] === "session")
      return {
        ...fixture.view,
        active_window_id: model.focused ? windowId : undefined,
        windows: fixture.view.windows.map((window) => ({
          ...window,
          focused_block_id: model.focused ? blockId : undefined,
        })),
      };
    return fixture.query(args, signal);
  });
  const run = vi.fn<RexCommand>().mockImplementation(async (args, signal) => {
    signal.throwIfAborted();
    mutations.push(args);
    if (args[0] === "focus") model.focused = true;
    return "";
  });
  const controller = new AbortController();
  const navigate = () => navigateRexPane(query, run, pane, select, controller.signal);
  return { fixture, model, connected, mutations, queries, query, run, select, controller, navigate };
}
