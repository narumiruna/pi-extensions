import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectTrustUpdate, RpcResponse } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, test } from "vitest";
import type { TrustObservation } from "./pi-project-trust-observer.js";
import { ProjectTrustRpc, removeUnconfiguredProjectPackage } from "./pi-project-trust-rpc.js";

type Decision = "false" | "true" | "absent" | "parent-false" | "parent-false-child-true" | "parent-true-child-false";
const cases: { resource: "agents" | "notify"; decision: Decision; trusted: boolean; saved: boolean | null }[] = [
  { resource: "agents", decision: "false", trusted: false, saved: false },
  { resource: "notify", decision: "false", trusted: false, saved: false },
  { resource: "notify", decision: "true", trusted: true, saved: true },
  { resource: "notify", decision: "absent", trusted: true, saved: null },
  { resource: "notify", decision: "parent-false", trusted: false, saved: false },
  { resource: "notify", decision: "parent-false-child-true", trusted: true, saved: true },
  { resource: "notify", decision: "parent-true-child-false", trusted: false, saved: false },
];

function assertHandled(response: RpcResponse): void {
  assert.ok(response.success && response.command === "prompt", JSON.stringify(response));
  assert.equal(response.data.disposition, "handled");
}

for (const scenario of cases) {
  describe(`${scenario.resource}-only project, saved decision ${scenario.decision}`, () => {
    let root: string;
    let cwd: string;
    let client: ProjectTrustRpc;
    let owned: { dispose: () => Promise<void> }[];
    let savedBytes: string | undefined;
    let projectBytes: string;

    const start = async (updates: ProjectTrustUpdate[] = []) => {
      const runtime = new ProjectTrustRpc(root, cwd, updates);
      owned.push(runtime);
      await runtime.ready();
      assert.deepEqual(runtime.savedDecision, {
        type: "saved_decision",
        decision: scenario.saved,
        requiresTrust: false,
      });
      return runtime;
    };
    const projectContents = () =>
      readFile(join(cwd, ...(scenario.resource === "agents" ? ["AGENTS.md"] : [".pi", "pi-notify.json"])), "utf8");
    const savedContents = () =>
      readFile(join(root, "agent", "trust.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    const assertObservations = (runtime: ProjectTrustRpc, expected: [TrustObservation["phase"], string?][]) => {
      const observed = runtime.observations();
      // RPC can bind the replacement session twice; verify every trust value without fixing that count.
      const lifecycle = observed.filter((entry, index) => {
        const previous = observed[index - 1];
        return !(
          entry.phase === "start" &&
          entry.reason === "new" &&
          previous?.phase === "start" &&
          previous.reason === "new" &&
          previous.sessionId === entry.sessionId
        );
      });
      assert.deepEqual(
        lifecycle.map((entry) => [entry.phase, entry.reason]),
        expected.map(([phase, reason]) => [phase, reason]),
      );
      for (const entry of observed) {
        assert.equal(entry.trusted, scenario.trusted, JSON.stringify(entry));
        assert.equal(resolve(entry.cwd), resolve(cwd));
        assert.ok(entry.sessionId);
      }
      runtime.assertNoModelRun();
      return observed;
    };

    beforeEach(async (context) => {
      root = await mkdtemp(join(tmpdir(), "pi-project-trust-runtime-"));
      cwd = join(root, "projects", "workspace");
      owned = [];
      context.onTestFinished(async () => {
        try {
          await Promise.all(owned.map((runtime) => runtime.dispose()));
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
      await mkdir(cwd, { recursive: true });
      await mkdir(join(root, "home"), { recursive: true });
      await mkdir(join(root, "agent"), { recursive: true });
      if (scenario.resource === "agents") {
        await writeFile(join(cwd, "AGENTS.md"), "# Isolated project trust runtime fixture\n");
      } else {
        await mkdir(join(cwd, ".pi"));
        await writeFile(join(cwd, ".pi", "pi-notify.json"), '{"enabled":false}\n');
      }
      projectBytes = await projectContents();
      // Synthetic availability only: no provider server exists and no model prompt is sent.
      await writeFile(
        join(root, "agent", "models.json"),
        JSON.stringify({
          providers: {
            "project-trust-runtime": {
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "not-a-credential",
              models: [{ id: "unused" }],
            },
          },
        }),
      );
      const updates: ProjectTrustUpdate[] = [];
      if (scenario.decision.startsWith("parent-")) {
        updates.push({ path: join(root, "projects"), decision: scenario.decision === "parent-true-child-false" });
        if (scenario.decision !== "parent-false") {
          updates.push({ path: cwd, decision: scenario.decision === "parent-false-child-true" });
        }
      } else if (scenario.decision !== "absent") {
        updates.push({ path: cwd, decision: scenario.decision === "true" });
      }
      // CLI startup is a hook, not an enlarged per-test timeout; get_commands confirms readiness.
      client = await start(updates);
      savedBytes = await savedContents();
    });

    test("preserves saved trust through startup, reload, new session, and a fresh CLI process", async () => {
      assert.deepEqual(await readdir(cwd), scenario.resource === "agents" ? ["AGENTS.md"] : [".pi"]);
      if (scenario.resource === "notify") {
        assert.deepEqual(await readdir(join(cwd, ".pi")), ["pi-notify.json"]);
      }
      const startup = assertObservations(client, [["start", "startup"]]);
      assertHandled(await client.request({ type: "prompt", message: "/trust-runtime-observe" }));
      assertHandled(await client.request({ type: "prompt", message: "/trust-runtime-reload" }));
      assertHandled(await client.request({ type: "prompt", message: "/trust-runtime-observe" }));
      const replacement = await client.request({ type: "new_session" });
      assert.ok(replacement.success && replacement.command === "new_session", JSON.stringify(replacement));
      assert.equal(replacement.data.cancelled, false);
      assertHandled(await client.request({ type: "prompt", message: "/trust-runtime-observe" }));
      const messages = await client.request({ type: "get_messages" });
      assert.ok(messages.success && messages.command === "get_messages", JSON.stringify(messages));
      assert.deepEqual(messages.data.messages, []);
      await client.close();
      const observations = assertObservations(client, [
        ["start", "startup"],
        ["observe"],
        ["shutdown", "reload"],
        ["start", "reload"],
        ["observe"],
        ["shutdown", "new"],
        ["start", "new"],
        ["observe"],
        ["shutdown", "quit"],
      ]);
      assert.equal(observations[3]?.sessionId, startup[0]?.sessionId, "reload keeps the session");
      assert.notEqual(observations[6]?.sessionId, startup[0]?.sessionId, "new_session replaces the session");
      assert.equal(await savedContents(), savedBytes, "runtime operations do not rewrite saved trust");

      // No updates are supplied again: this process must resolve the same on-disk decision itself.
      const fresh = await start();
      assertHandled(await fresh.request({ type: "prompt", message: "/trust-runtime-observe" }));
      await fresh.close();
      assertObservations(fresh, [["start", "startup"], ["observe"], ["shutdown", "quit"]]);
      assert.equal(await savedContents(), savedBytes);
      assert.equal(await projectContents(), projectBytes, "runtime operations do not change project files");
    });

    test("uses saved trust before a non-interactive local package command", async () => {
      await client.close();
      const command = removeUnconfiguredProjectPackage(root, cwd);
      owned.push(command);
      const result = await command.result;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.deepEqual(result.savedDecision, {
        type: "saved_decision",
        decision: scenario.saved,
        requiresTrust: false,
      });
      // Unlike RPC bootstrap, this calls the resolver even without Pi-protected resources.
      assert.deepEqual(
        { stdout: result.stdout, stderr: result.stderr },
        scenario.trusted
          ? {
              stdout: "Removing ./never-configured...\n",
              stderr: "No matching package found for ./never-configured\n",
            }
          : {
              stdout: "",
              stderr: "Project is not trusted. Use --approve to modify local package config.\n",
            },
      );
      assert.deepEqual(await readdir(cwd), scenario.resource === "agents" ? ["AGENTS.md"] : [".pi"]);
      if (scenario.resource === "notify") {
        assert.deepEqual(await readdir(join(cwd, ".pi")), ["pi-notify.json"]);
      }
      assert.equal(await savedContents(), savedBytes, "the command does not change saved trust");
      assert.equal(await projectContents(), projectBytes, "the command does not change project files");
    });
  });
}
