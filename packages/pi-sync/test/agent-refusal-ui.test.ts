import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionCommandContext, initTheme, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { completeSyncArguments, parseOptions, usage } from "../src/commands/command.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import type { RunRoute } from "../src/ui/cancellable-operation.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { refusalFixture } from "./agent-refusal-test-helpers.js";
import { selectRemote } from "./agent-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { deferred } from "./startup-check-helpers.js";

initTheme("dark", false);

const retryLabel = "Retry refused model result…";
const approval = "Yes, Send one fresh request";
const remappedKeys: Record<string, KeyId[]> = {
  "tui.select.up": ["k"],
  "tui.select.down": ["j"],
  "tui.select.confirm": ["l"],
  "tui.select.cancel": ["q"],
};

function refusalTui(remapped = false, width = 120, rows = 80) {
  return createTuiHarness({
    width,
    rows,
    ...(remapped
      ? {
          keybindings: {
            getKeys: (action: string) => remappedKeys[action] ?? [],
            matches: (data: string, action: string) =>
              (remappedKeys[action] ?? []).some((key) => matchesKey(data, key)),
          },
        }
      : {}),
  });
}

type RefusalFixture = Awaited<ReturnType<typeof refusalFixture>>;

function refusalTest(name: string, run: (fixture: RefusalFixture, agentDir: string) => Promise<void>) {
  describe(name, () => {
    const ready = deferred<{ fixture: RefusalFixture; agentDir: string }>();
    const release = deferred();
    let lifetime: Promise<void>;
    let active: Promise<void> | undefined;
    beforeAll(async () => {
      lifetime = withTempHome(async (agentDir) => {
        const fixture = await refusalFixture(agentDir);
        ready.resolve({ fixture, agentDir });
        await release.promise;
      });
      await Promise.race([ready.promise, lifetime]);
    });
    afterAll(async () => {
      try {
        await active;
      } finally {
        release.resolve();
        await lifetime;
      }
    });
    test(name, async () => {
      const { fixture, agentDir } = await ready.promise;
      active = run(fixture, agentDir);
      await active;
    });
  });
}

async function assertRefusalUntouched(f: RefusalFixture, agentDir: string, head: unknown, requests = 1) {
  assert.equal(f.mock.requests.length, requests);
  assert.equal(await fs.readFile(f.file, "utf8"), f.original);
  assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
  assert.deepEqual(await f.backend.readHead(), head);
  await assert.rejects(fs.stat(path.join(f.root, "claim.json")), /ENOENT/);
  assert.equal(f.mock.statuses.get("sync"), undefined);
}

for (const remapped of [false, true]) {
  for (const exit of ["safe default", "approve", "cancel", "Ctrl+C", "dispose"] as const) {
    refusalTest(`refusal retry TUI ${exit} with ${remapped ? "remapped" : "default"} keys`, async (f, agentDir) => {
      const head = await f.backend.readHead();
      f.answer();
      const tui = refusalTui(remapped);
      f.mock.ctx.mode = "tui";
      f.mock.ctx.ui.custom = tui.custom;
      const running = f.run({ agentRetryRefusal: true, yes: true });
      try {
        await tui.waitForOpen();
        const lines = tui.render();
        const frame = lines.join("\n");
        assert.ok(lines.every((line) => visibleWidth(line) <= 120));
        assert.ok(lines.length <= 77);
        assert.match(frame, /→ No, cancel/);
        assert.match(frame, /Retry refused model result/);
        assert.match(frame, /Setup: home/);
        assert.match(frame, /Storage connection: r2/);
        assert.match(frame, /Storage path: pi-sync\/home/);
        assert.match(frame, /Bucket: pi-sync-test/);
        assert.match(frame, /Selected model: sync-test\/sync-test/);
        assert.match(frame, /Conflict paths: AGENTS.md/);
        assert.match(frame, /one fresh provider request/);
        assert.match(frame, /may incur costs/);
        assert.match(frame, /accounting is not cleared or reset/);
        assert.doesNotMatch(frame, /secret-key|access-key/);
        assert.equal(f.mock.requests.length, 1, "--yes must not bypass the retry review");
        if (exit === "dispose") tui.dispose();
        else if (exit === "Ctrl+C") tui.press("ctrl+c");
        else if (exit === "cancel") tui.send(remapped ? "q" : "\u001b");
        else {
          if (exit === "approve") tui.send(remapped ? "j" : "\u001b[B");
          tui.send(remapped ? "l" : "\r");
        }
        if (exit === "approve") {
          assert.equal(await running, "applied");
          assert.equal(f.mock.requests.length, 2, "one approval permits exactly one fresh request");
          assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
          assert.notEqual(await fs.readFile(f.file, "utf8"), f.original);
        } else {
          assert.equal(await running, "cancelled");
          await assertRefusalUntouched(f, agentDir, head);
        }
      } finally {
        tui.dispose();
        await running.catch(() => undefined);
      }
    });
  }
}

for (const response of [approval, "No, cancel", undefined] as const) {
  refusalTest(
    `refusal retry RPC ${response ?? "dismissal"} uses the real review without custom UI`,
    async (f, agentDir) => {
      const head = await f.backend.readHead();
      const dialogs: Array<{ title: string; choices: string[] }> = [];
      let customCalls = 0;
      f.answer();
      f.mock.ctx.ui.custom = async () => {
        customCalls++;
        throw new Error("RPC must not open custom UI");
      };
      f.mock.ctx.ui.select = async (title, choices) => {
        dialogs.push({ title, choices });
        return response;
      };
      const result = await f.run({ agentRetryRefusal: true, yes: true });
      assert.equal(customCalls, 0);
      assert.equal(dialogs.length, 1);
      assert.deepEqual(dialogs[0].choices.slice(0, 3), ["No, cancel", approval, "View details"]);
      assert.match(dialogs[0].title, /Setup: home/);
      assert.match(dialogs[0].title, /Storage path: pi-sync\/home/);
      assert.match(dialogs[0].title, /one fresh provider request/);
      assert.match(dialogs[0].title, /may incur costs/);
      assert.doesNotMatch(dialogs[0].title, /secret-key|access-key/);
      if (response === approval) {
        assert.equal(result, "applied");
        assert.equal(f.mock.requests.length, 2);
      } else {
        assert.equal(result, "cancelled");
        await assertRefusalUntouched(f, agentDir, head);
      }
    },
  );
}

refusalTest("retry details are read-only and returning to confirmation restores No", async (f, agentDir) => {
  const head = await f.backend.readHead();
  const dialogs: Array<{ title: string; choices: string[] }> = [];
  let confirmations = 0;
  f.mock.ctx.ui.select = async (title, choices) => {
    dialogs.push({ title, choices });
    if (choices.includes("View details")) return ++confirmations === 1 ? "View details" : choices[0];
    return choices.includes("Next") ? "Next" : "Back";
  };
  assert.equal(await f.run({ agentRetryRefusal: true }), "cancelled");
  assert.equal(confirmations, 2);
  const reviews = dialogs.filter((dialog) => dialog.choices.includes("View details"));
  assert.ok(reviews.every((dialog) => dialog.choices[0] === "No, cancel"));
  const details = dialogs.filter((dialog) => !dialog.choices.includes("View details"));
  assert.ok(details.length > 0);
  assert.ok(details.every((dialog) => !dialog.choices.some((choice) => choice.startsWith("Yes,"))));
  assert.match(details.map((dialog) => dialog.title).join("\n"), /Cancellation cannot recall submitted content/);
  await assertRefusalUntouched(f, agentDir, head);
});

for (const boundary of ["confirmation", "request"] as const) {
  for (const end of ["cancel", "session replacement"] as const) {
    refusalTest(`retry ${end} during ${boundary} cannot publish late output`, async (f, agentDir) => {
      const head = await f.backend.readHead();
      const owner = new AbortController();
      const ready = deferred();
      const finish = deferred<string>();
      let confirmationSignal: AbortSignal | undefined;
      f.mock.ctx.ui.select = async (_title, _choices, options) => {
        confirmationSignal = options?.signal;
        if (boundary === "request") return approval;
        ready.resolve();
        return finish.promise;
      };
      f.answer(async () => {
        ready.resolve();
        return finish.promise;
      });
      const running = f.run({ agentRetryRefusal: true, signal: owner.signal });
      const rejected = assert.rejects(running, /AbortError|Session changed|cancel/);
      try {
        await ready.promise;
        if (end === "session replacement") {
          f.mock.ctx.sessionManager = { ...f.mock.ctx.sessionManager, getSessionId: () => "replacement" };
        }
        owner.abort(new DOMException(end, "AbortError"));
        finish.resolve(boundary === "confirmation" ? approval : selectRemote([]));
        await rejected;
        if (boundary === "confirmation") assert.equal(confirmationSignal?.aborted, true);
        else assert.equal((f.mock.requestOptions[1] as { signal: AbortSignal }).signal.aborted, true);
        await assertRefusalUntouched(f, agentDir, head, boundary === "request" ? 2 : 1);
      } finally {
        owner.abort();
        finish.resolve(approval);
        await running.catch(() => undefined);
      }
    });
  }
}

refusalTest("a replaced session cannot approve an already open TUI refusal review", async (f, agentDir) => {
  const head = await f.backend.readHead();
  const tui = refusalTui();
  f.mock.ctx.mode = "tui";
  f.mock.ctx.ui.custom = tui.custom;
  const running = f.run({ agentRetryRefusal: true });
  const rejected = assert.rejects(running, /Session changed/);
  try {
    await tui.waitForOpen();
    tui.render();
    f.mock.ctx.sessionManager = { ...f.mock.ctx.sessionManager, getSessionId: () => "replacement" };
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await rejected;
    await assertRefusalUntouched(f, agentDir, head);
  } finally {
    tui.dispose();
    await running.catch(() => undefined);
  }
});

for (const mode of ["print", "json"] as const) {
  refusalTest(`${mode} cannot infer through the internal refusal retry option`, async (f, agentDir) => {
    const head = await f.backend.readHead();
    let dialogs = 0;
    f.mock.ctx.mode = mode;
    f.mock.ctx.hasUI = false;
    f.mock.ctx.ui.select = async () => {
      dialogs++;
      return approval;
    };
    f.mock.ctx.ui.custom = async () => {
      dialogs++;
      throw new Error("Unexpected custom UI");
    };
    await assert.rejects(f.run({ agentRetryRefusal: true, yes: true }), /foreground TUI or RPC manager review/);
    assert.equal(dialogs, 0);
    await assertRefusalUntouched(f, agentDir, head);
  });
}

async function managerSettings(agentDir: string, enabled = true) {
  await fs.mkdir(agentDir, { recursive: true });
  const settings = v3S3Settings();
  Object.assign(settings.syncSetups.home.sync, { agentMode: enabled, mergeSettings: true });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
}

for (const enabled of [false, true]) {
  test(`manager exposes refusal retry only with Agent mode ${enabled ? "on" : "off"}`, async () =>
    withTempHome(async (agentDir) => {
      await managerSettings(agentDir, enabled);
      const manager = await describeManagerState();
      assert.equal(manager.actions.includes(retryLabel), enabled);
      assert.ok(manager.actions.includes("Sync now"));
    }));
}

test("RPC manager routes only explicit retry through the sixth internal argument", async () =>
  withTempHome(async (agentDir) => {
    await managerSettings(agentDir);
    const choices = [retryLabel, "Sync now", "Check remote status", undefined];
    const calls: Parameters<RunRoute>[] = [];
    const owner = new AbortController();
    const { ctx } = createMockContext({
      mode: "rpc",
      select: async () => choices.shift(),
      custom: async () => {
        throw new Error("RPC custom UI is forbidden");
      },
    });
    await showSyncManager(
      ctx,
      async (...args) => {
        calls.push(args);
        return { kind: "completed" };
      },
      owner.signal,
    );
    assert.deepEqual(
      calls.map((args) => [args[0], args[5]]),
      [
        ["sync", true],
        ["sync", undefined],
        ["status", undefined],
      ],
    );
    assert.ok(calls.every((args) => args[1] instanceof AbortSignal));
    assert.ok(calls.every((args) => !args[0].includes("retry") && !args[0].includes("--")));
    assert.equal(choices.length, 0);
  }));

for (const kind of ["decision-required", "remote-selection-required"] as const)
  for (const expired of [false, true])
    test(`manager retry ${kind} guidance respects expired owner ${expired}`, async () =>
      withTempHome(async (agentDir) => {
        await managerSettings(agentDir);
        const choices = [retryLabel, undefined];
        const owner = new AbortController();
        const mock = createMockContext({ mode: "rpc", select: async () => choices.shift() });
        let calls = 0;
        await showSyncManager(
          mock.ctx,
          async (route, _signal, _onCommit, _target, _onDialog, retry) => {
            calls++;
            assert.equal(route, "sync");
            assert.equal(retry, true);
            if (expired) owner.abort(new DOMException("Session replaced", "AbortError"));
            // Report the variant, not a different recovery direction or stale notification.
            return { kind, decision: {} as never };
          },
          owner.signal,
        );
        assert.equal(calls, 1);
        assert.equal(
          mock.notifications.some(
            (item) =>
              item.level === "warning" && /Use Sync now to review changed selection or recovery/.test(item.message),
          ),
          !expired,
        );
        assert.equal(choices.length, expired ? 1 : 0);
      }));

for (const end of ["Ctrl+C", "dispose", "session replacement"] as const) {
  test(`TUI manager retry propagates ${end} to owned work and releases its listener`, async () =>
    withTempHome(async (agentDir) => {
      await managerSettings(agentDir);
      const tui = refusalTui(true);
      const owner = new AbortController();
      const listeners = new Set<TerminalInputHandler>();
      const ready = deferred<Parameters<RunRoute>>();
      let drained = false;
      const context = createMockContext({
        mode: "tui",
        custom: tui.custom,
        onTerminalInput(handler: TerminalInputHandler) {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      });
      const running = showSyncManager(
        context.ctx,
        async (...args) => {
          ready.resolve(args);
          await new Promise<void>((resolve) => args[1]?.addEventListener("abort", () => resolve(), { once: true }));
          drained = true;
          return { kind: "failed" };
        },
        owner.signal,
      );
      try {
        await tui.waitForOpen();
        tui.render();
        tui.send("j");
        tui.send("l");
        const args = await ready.promise;
        await waitForOpenCount(tui, 2);
        assert.equal(args[0], "sync");
        assert.equal(args[5], true);
        assert.equal(typeof args[2], "function", "retry is commit-aware");
        assert.equal(typeof args[4], "function", "retry retains cancellation across dialogs");
        assert.equal(listeners.size, 1);
        if (end === "Ctrl+C") {
          args[4]?.(true);
          const listener = [...listeners][0];
          assert.equal(listener("q"), undefined, "ordinary cancellation belongs to the focused dialog");
          assert.deepEqual(listener("\u0003"), { consume: true });
        } else if (end === "dispose") tui.dispose();
        else owner.abort(new DOMException("Session replaced", "AbortError"));
        if (end === "Ctrl+C") {
          await waitForOpenCount(tui, 3);
          tui.send("q");
        }
        await running;
        assert.equal(args[1]?.aborted, true);
        assert.equal(drained, true);
        assert.equal(listeners.size, 0);
        if (end === "Ctrl+C") {
          assert.ok(
            context.notifications.some((item) =>
              /Submitted requests and committed writes cannot be undone/.test(item.message),
            ),
          );
        }
      } finally {
        owner.abort();
        tui.dispose();
        await running.catch(() => undefined);
      }
    }));
}

refusalTest("registered manager retries only after review and preserves the parent prefix and tools", async (f) => {
  const tools = [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    { name: "bash", description: "Execute a command", parameters: { type: "object", properties: {} } },
  ];
  const parentMessages = [
    { role: "user", content: "Keep this parent conversation private", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Parent response" }], timestamp: 2 },
  ];
  const branch = parentMessages.map((message, index) => ({ type: "message", id: String(index), message }));
  const systemPrompt = "Stable parent system instructions";
  Object.assign(f.mock.ctx, { getSystemPrompt: () => systemPrompt });
  f.mock.ctx.sessionManager = {
    ...f.mock.ctx.sessionManager,
    getBranch: () => branch as never,
    getEntries: () => branch as never,
  };
  const parent = createMockPi({ activeTools: ["read", "bash"], allTools: tools });
  const normalizedParent = () =>
    JSON.stringify({
      systemPrompt: f.mock.ctx.getSystemPrompt(),
      activeTools: parent.rawPi.getActiveTools(),
      definitions: parent.rawPi.getAllTools(),
      messages: f.mock.ctx.sessionManager.getBranch(),
    });
  const before = normalizedParent();
  const choices = ["Sync now", retryLabel, approval, undefined];
  const dialogs: Array<{ title: string; requests: number }> = [];
  f.mock.ctx.ui.select = async (title) => {
    dialogs.push({ title, requests: f.mock.requests.length });
    return choices.shift();
  };
  f.answer();
  const { default: extension } = await import("../src/sync-extension.js");
  extension(parent.pi, {
    loadSyncOperations: async () => ({
      ...(await import("../src/sync/sync-operations.js")),
      syncBoth: (ctx, options) => syncBoth(ctx, options, () => f.backend),
    }),
  });
  const command = parent.commands.get("sync");
  assert.ok(command);
  await command.handler("", f.mock.ctx as ExtensionCommandContext);
  assert.equal(choices.length, 0);
  assert.equal(f.mock.requests.length, 2);
  assert.ok(f.mock.notifications.some((item) => /refused/.test(item.message)));
  const review = dialogs.find((dialog) => /Retry refused model result\?/.test(dialog.title));
  assert.ok(review);
  assert.equal(review.requests, 1, "ordinary Sync now must reuse the refusal without inference");
  assert.equal(normalizedParent(), before);
  assert.deepEqual(parent.sentMessages, []);
  assert.deepEqual(parent.sentUserMessages, []);
  assert.deepEqual(parent.entries, []);
  assert.equal(parent.events.has("context"), false);
  assert.equal(parent.events.has("before_agent_start"), false);
  assert.equal(parent.events.has("before_provider_request"), false);
  const resolverInputs = f.mock.requests.map((request) => ({
    systemPrompt: request.systemPrompt,
    tools: request.tools ?? [],
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  }));
  assert.deepEqual(resolverInputs[1], resolverInputs[0]);
  for (const request of f.mock.requests) {
    assert.deepEqual(request.tools ?? [], []);
    assert.equal(request.messages.filter((message) => message.role === "user").length, 1);
    assert.doesNotMatch(
      JSON.stringify(request),
      /Stable parent system|Keep this parent conversation private|Parent response/,
    );
  }
  await parent.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, f.mock.ctx);
});

for (const boundary of ["confirmation", "request"] as const) {
  refusalTest(`registered manager session replacement drains refusal retry during ${boundary}`, async (f, agentDir) => {
    const head = await f.backend.readHead();
    const parent = createMockPi();
    const ready = deferred();
    const finish = deferred<string>();
    let reviewSignal: AbortSignal | undefined;
    f.mock.ctx.ui.select = async (_title, choices, options) => {
      if (choices.includes(retryLabel)) return retryLabel;
      reviewSignal = options?.signal;
      if (boundary === "request") return approval;
      ready.resolve();
      return finish.promise;
    };
    f.answer(async () => {
      ready.resolve();
      return finish.promise;
    });
    const { default: extension } = await import("../src/sync-extension.js");
    extension(parent.pi, {
      loadSyncOperations: async () => ({
        ...(await import("../src/sync/sync-operations.js")),
        syncBoth: (ctx, options) => syncBoth(ctx, options, () => f.backend),
      }),
    });
    const command = parent.commands.get("sync");
    assert.ok(command);
    const running = Promise.resolve(command.handler("", f.mock.ctx as ExtensionCommandContext));
    const replacement = createMockContext({ mode: "json", hasUI: false });
    try {
      await ready.promise;
      await parent.events.get("session_start")?.[0]?.({ reason: "new" }, replacement.ctx);
      finish.resolve(boundary === "confirmation" ? approval : selectRemote([]));
      await running;
      if (boundary === "confirmation") assert.equal(reviewSignal?.aborted, true);
      else assert.equal((f.mock.requestOptions[1] as { signal: AbortSignal }).signal.aborted, true);
      await assertRefusalUntouched(f, agentDir, head, boundary === "request" ? 2 : 1);
      assert.equal(f.mock.notifications.filter((item) => item.level === "error").length, 0);
    } finally {
      finish.resolve(approval);
      await parent.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, replacement.ctx);
      await running.catch(() => undefined);
    }
  });
}

test("refusal retry has no textual flag, command, completion, or help route", () => {
  for (const flag of ["--retry-refusal", "--agent-retry-refusal", "--retry-refused-model"]) {
    assert.throws(() => parseOptions([flag]), /Unknown sync option/);
  }
  assert.doesNotMatch(JSON.stringify(completeSyncArguments("")), /retry-refusal|refused model/);
  assert.doesNotMatch(JSON.stringify(completeSyncArguments("sync --")), /retry/);
  assert.doesNotMatch(usage(), /retry-refusal|--agent-retry/);
});

async function waitForOpenCount(tui: ReturnType<typeof createTuiHarness>, count: number) {
  while (tui.openCount < count) {
    await tui.waitForOpen();
    if (tui.openCount < count) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
