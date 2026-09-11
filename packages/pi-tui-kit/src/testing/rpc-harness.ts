import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { RpcDialogRecord, RpcHarness, RpcHarnessStep } from "./types.js";

interface CallWaiter {
  resolve(record: RpcDialogRecord): void;
}

export function createRpcHarness(steps: readonly RpcHarnessStep[]): RpcHarness {
  const script = steps.map(copyStep);
  const records: RpcDialogRecord[] = [];
  const waiters: CallWaiter[] = [];
  let scriptIndex = 0;
  let waitIndex = 0;
  let pendingCalls = 0;

  const input: ExtensionContext["ui"]["input"] = async (title, placeholder, options) => {
    const step = consumeStep("input", { title, placeholder }, options);
    if (options?.signal?.aborted) return undefined;
    if (step.waitForAbort) return waitForAbort(options?.signal, "input");
    return step.response;
  };
  const select: ExtensionContext["ui"]["select"] = async (title, options, dialogOptions) => {
    const step = consumeStep("select", { title, options }, dialogOptions);
    if (dialogOptions?.signal?.aborted) return undefined;
    if (step.waitForAbort) return waitForAbort(dialogOptions?.signal, "select");
    if (step.response !== undefined && !options.includes(step.response)) {
      throw new Error(`Scripted select response ${JSON.stringify(step.response)} is not one of the offered options`);
    }
    return step.response;
  };
  const custom: ExtensionContext["ui"]["custom"] = async () => {
    throw new Error("RPC harness does not support custom TUI");
  };
  const ui = Object.freeze({ input, select, custom });

  function consumeStep(
    kind: "input",
    actual: { title: string; placeholder?: string },
    options?: ExtensionUIDialogOptions,
  ): Extract<RpcHarnessStep, { kind: "input" }>;
  function consumeStep(
    kind: "select",
    actual: { title: string; options: readonly string[] },
    options?: ExtensionUIDialogOptions,
  ): Extract<RpcHarnessStep, { kind: "select" }>;
  function consumeStep(
    kind: "input" | "select",
    actual: { title: string; placeholder?: string; options?: readonly string[] },
    options?: ExtensionUIDialogOptions,
  ): RpcHarnessStep {
    const step = script[scriptIndex];
    if (!step) throw new Error(`Unexpected ${kind} RPC call: script is exhausted`);
    if (step.kind !== kind) {
      throw new Error(`Expected ${step.kind} RPC call but received ${kind}`);
    }
    if (step.title !== undefined && step.title !== actual.title) {
      throw new Error(
        `Expected ${kind} title ${JSON.stringify(step.title)} but received ${JSON.stringify(actual.title)}`,
      );
    }
    if (kind === "input" && step.kind === "input") {
      if (step.placeholder !== undefined && step.placeholder !== actual.placeholder) {
        throw new Error(
          `Expected input placeholder ${JSON.stringify(step.placeholder)} but received ${JSON.stringify(actual.placeholder)}`,
        );
      }
    } else if (kind === "select" && step.kind === "select" && step.options !== undefined) {
      if (!sameStrings(step.options, actual.options ?? [])) {
        throw new Error(
          `Expected select options ${JSON.stringify(step.options)} but received ${JSON.stringify(actual.options ?? [])}`,
        );
      }
    }

    scriptIndex += 1;
    const record = Object.freeze({
      kind,
      title: actual.title,
      ...(kind === "input" ? { placeholder: actual.placeholder } : {}),
      ...(kind === "select" ? { options: Object.freeze([...(actual.options ?? [])]) } : {}),
      signalWasAborted: options?.signal?.aborted ?? false,
    }) satisfies RpcDialogRecord;
    recordCall(record);
    return step;
  }

  function recordCall(record: RpcDialogRecord) {
    records.push(record);
    const waiter = waiters.shift();
    if (waiter) {
      waitIndex += 1;
      waiter.resolve(record);
    }
  }

  async function waitForAbort(signal: AbortSignal | undefined, kind: "input" | "select") {
    if (!signal) throw new Error(`Pending ${kind} RPC step requires an AbortSignal`);
    if (signal.aborted) return undefined;
    pendingCalls += 1;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        onAbort = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      return undefined;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      pendingCalls -= 1;
    }
  }

  return {
    ui,
    get dialogs() {
      return Object.freeze([...records]);
    },
    get remainingSteps() {
      return script.length - scriptIndex;
    },
    waitForCall() {
      const existing = records[waitIndex];
      if (existing) {
        waitIndex += 1;
        return Promise.resolve(existing);
      }
      return new Promise<RpcDialogRecord>((resolve) => waiters.push({ resolve }));
    },
    assertConsumed() {
      const remaining = script.length - scriptIndex;
      if (remaining > 0) {
        throw new Error(`${remaining} scripted RPC step${remaining === 1 ? " remains" : "s remain"}`);
      }
      if (pendingCalls > 0) throw new Error(`${pendingCalls} scripted RPC call is still pending`);
    },
  };
}

function copyStep(step: RpcHarnessStep): RpcHarnessStep {
  return Object.freeze({
    ...step,
    ...(step.kind === "select" && step.options ? { options: Object.freeze([...step.options]) } : {}),
  });
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
