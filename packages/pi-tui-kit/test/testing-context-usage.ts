import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as production from "../src/index.js";
import {
  createRpcHarness,
  createTuiHarness,
  type RpcDialogRecord,
  type RpcHarness,
  type RpcHarnessStep,
  type TuiHarness,
  type TuiHarnessKey,
  type TuiHarnessOptions,
} from "../src/testing/index.js";

const tuiOptions: TuiHarnessOptions = { width: 80, rows: 24 };
const tui: TuiHarness = createTuiHarness(tuiOptions);
const custom: ExtensionContext["ui"]["custom"] = tui.custom;
const key: TuiHarnessKey = "tui.select.confirm";
void custom;
void key;

const steps: readonly RpcHarnessStep[] = [
  { kind: "input", title: "Value", response: "12" },
  { kind: "select", title: "Apply?", options: ["Apply", "Back"], response: "Apply" },
];
const rpc: RpcHarness = createRpcHarness(steps);
const rpcUi: Pick<ExtensionContext["ui"], "input" | "select" | "custom"> = rpc.ui;
const dialogs: readonly RpcDialogRecord[] = rpc.dialogs;
void rpcUi;
void dialogs;

// @ts-expect-error Testing helpers stay off the production entrypoint.
production.createTuiHarness;
// @ts-expect-error Testing helpers stay off the production entrypoint.
production.createRpcHarness;
// @ts-expect-error The TUI harness never exposes its raw component.
tui.component;
// @ts-expect-error Dialog observations are immutable.
rpc.dialogs.push({ kind: "input", title: "bad", signalWasAborted: false });
// @ts-expect-error Script observations cannot be mutated through their readonly choice list.
rpc.dialogs[0]?.options?.push("bad");
