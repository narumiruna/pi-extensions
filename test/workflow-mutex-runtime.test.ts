import assert from "node:assert/strict";
import {
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

// Keep the transport shape local to this characterization test.
// The protocol is repository documentation, not a Pi-owned exported type.
type WorkflowMutexAttemptV1 = {
  session: object;
  group: string;
  busy: boolean;
  listenerStarts: string[];
  synchronousMutation?: boolean;
  afterAwaitMutation?: boolean;
};

test("createEventBus starts every listener synchronously and exposes only pre-await mutations", async () => {
  const eventBus = createEventBus();
  let releaseAsyncListener!: () => void;
  let finishAsyncListener!: () => void;
  const asyncGate = new Promise<void>((resolve) => {
    releaseAsyncListener = resolve;
  });
  const asyncFinished = new Promise<void>((resolve) => {
    finishAsyncListener = resolve;
  });
  const session = {};
  const attempt: WorkflowMutexAttemptV1 = {
    session,
    group: "agent-workflow",
    busy: false,
    listenerStarts: [],
  };

  eventBus.on("workflow:mutex:v1", (data) => {
    const current = data as WorkflowMutexAttemptV1;
    current.listenerStarts.push("holder");
    current.busy = true;
  });
  eventBus.on("workflow:mutex:v1", (data) => {
    const current = data as WorkflowMutexAttemptV1;
    current.listenerStarts.push("later-participant");
    if (current.session === session && current.group === "agent-workflow" && !current.busy) {
      current.busy = true;
    }
  });
  eventBus.on("workflow:mutex:v1", async (data) => {
    const current = data as WorkflowMutexAttemptV1;
    current.listenerStarts.push("async-participant");
    current.synchronousMutation = true;
    await asyncGate;
    current.afterAwaitMutation = true;
    finishAsyncListener();
  });

  eventBus.emit("workflow:mutex:v1", attempt);

  assert.deepEqual(attempt.listenerStarts, ["holder", "later-participant", "async-participant"]);
  assert.equal(attempt.busy, true);
  assert.equal(attempt.synchronousMutation, true);
  assert.equal(attempt.afterAwaitMutation, undefined);

  releaseAsyncListener();
  await asyncFinished;
  assert.equal(attempt.afterAwaitMutation, true);
});

test("inline extension factories share one explicit bus and stale runtimes unsubscribe", async () => {
  const eventBus = createEventBus();
  const observations: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager: SettingsManager.inMemory({}),
    eventBus,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "runtime-characterization-sender",
        factory(pi) {
          pi.events.on("runtime-characterization", (data) => {
            observations.push("first");
            (data as { delivered?: boolean }).delivered = true;
          });
        },
      },
      {
        name: "runtime-characterization-receiver",
        factory(pi) {
          pi.events.on("runtime-characterization", (data) => {
            assert.equal((data as { delivered?: boolean }).delivered, true);
            observations.push("second");
          });
        },
      },
    ],
  });

  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 2);

  eventBus.emit("runtime-characterization", {});
  assert.deepEqual(observations, ["first", "second"]);

  loaded.runtime.invalidate("runtime characterization cleanup");
  eventBus.emit("runtime-characterization", {});
  assert.deepEqual(observations, ["first", "second"]);
});

test("ExtensionRunner contexts preserve one sessionManager object identity", async () => {
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager: SettingsManager.inMemory({}),
    eventBus,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          observedSessionManagers.push(ctx.sessionManager);
        });
      },
    ],
  });
  const observedSessionManagers: object[] = [];
  const sessionManager = {};

  await loader.reload();
  const loaded = loader.getExtensions();
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    process.cwd(),
    sessionManager as never,
    {} as never,
  );

  assert.equal(runner.createContext().sessionManager, sessionManager);
  assert.equal(runner.createCommandContext().sessionManager, sessionManager);
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(observedSessionManagers, [sessionManager]);
});
