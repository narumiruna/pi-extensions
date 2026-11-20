import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ClientFacts, findDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, test, vi } from "vitest";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { startObservableRpcOwner } from "./daemon-rpc-owner.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";

let fixture: RpcFixture;
let daemon: Awaited<ReturnType<typeof startObservableRpcOwner>>;
let client: SyncRpc;
let attached: ClientFacts;
let original: Record<string, unknown>;
let instance: string;
let before: number;

beforeEach(async (context) => {
  fixture = await createRpcFixture(context, path.resolve("packages/pi-sync"), async (agent) => {
    daemon = await startObservableRpcOwner(agent, context.signal);
    return () => daemon.stop();
  });
  await fixture.prepare(async () => {
    await fixture.startDaemon();
    await adoptFixtureRoot(fixture.agent);
    client = await fixture.connect();
    original = await client.start();
    const owner = await findDaemon(fixture.agent);
    assert.ok(owner);
    assert.equal(owner.identity.pid, daemon.pid);
    assert.notEqual(owner.identity.pid, client.child.pid);
    instance = owner.identity.instance;
    const wire = await daemon.inspect();
    const facts = wire.find(({ method, facts }) => method === "attach" && facts?.pid === client.child.pid)?.facts;
    assert.ok(facts);
    assert.equal(typeof original.sessionId, "string");
    assert.equal(facts.sessionId, original.sessionId);
    attached = facts;
    before = wire.length;
  });
});

async function checkedCommand(command: string, expected: string) {
  const from = client.records.length;
  assert.equal((await client.command(command, () => false)).disposition, "handled");
  const notifications = client.records
    .slice(from)
    .filter(({ type, method }) => type === "extension_ui_request" && method === "notify");
  assert.ok(
    notifications.some(({ message }) => String(message).includes(expected)),
    `${command} did not report ${JSON.stringify(expected)}: ${JSON.stringify(notifications)}`,
  );
  assert.ok(
    notifications.every(({ notifyType }) => notifyType !== "error"),
    JSON.stringify(notifications),
  );
}

async function checkedDaemonStatus() {
  await checkedCommand("/sync daemon status", `pi-sync-daemon: connected\nPID: ${daemon.pid}\nInstance: ${instance}`);
}

async function sameSessionWire() {
  const after = await client.call({ type: "get_state" });
  assert.equal(after.sessionId, original.sessionId);
  assert.equal(after.sessionFile, original.sessionFile);
  assert.equal(client.child.pid, attached.pid);
  assert.equal(client.sessionStarts, 1);
  const owner = await findDaemon(fixture.agent);
  assert.equal(owner?.identity.pid, daemon.pid);
  assert.equal(owner?.identity.instance, instance);
  const wire = (await daemon.inspect()).slice(before);
  assert.ok(
    wire.every(({ method }) => method !== "attach"),
    "Unexpected reattach or reload",
  );
  assert.equal(fixture.requests.length, 0, "No model requests on recovery");
  return wire;
}

async function checkSameSession() {
  const wire = await sameSessionWire();
  const repairs = wire.filter(({ method }) => method === "resume-contact");
  assert.equal(repairs.length, 1, JSON.stringify(repairs));
  const repair = repairs[0];
  assert.ok(repair?.facts);
  assert.equal(repair.error, undefined);
  assert.equal(repair.contact, "active");
  assert.equal(repair.facts.id, attached.id);
  assert.equal(repair.facts.generation, attached.generation);
  assert.equal(repair.facts.sessionId, original.sessionId);
  assert.equal(repair.facts.pid, client.child.pid);
  return wire;
}

test.each([
  ["unlock", "No pi-sync lock is present."],
  ["migrate-state --yes", "canonical pi-sync/ state directory"],
])("real Pi RPC recovery command %s publishes cleared busy facts", async (command, expected) => {
  await checkedCommand(`/sync ${command}`, expected);
  const wire = (await daemon.inspect()).slice(before);
  const submitted = wire.findIndex(({ method }) => method === "submit");
  assert.ok(submitted >= 0, JSON.stringify(wire));
  assert.equal(wire[submitted]?.operation, command.split(" ")[0]);
  const busy = wire.slice(0, submitted).filter(({ method }) => method === "update");
  assert.ok(busy.length > 0);
  assert.ok(busy.every(({ facts }) => facts?.idle === false));
  const cleared = wire.slice(submitted + 1).filter(({ method }) => method === "update");
  assert.equal(cleared.at(-1)?.facts?.idle, true, JSON.stringify(wire));
  assert.equal(cleared.at(-1)?.facts?.id, attached.id);
});

test("real Pi RPC help does not publish facts or repair expired contact", async () => {
  await daemon.expire(true);
  try {
    await checkedCommand("/sync help", "Usage: /sync");
    const wire = (await daemon.inspect()).slice(before);
    assert.ok(
      wire.every(({ method }) => !["attach", "update", "submit", "resume-contact"].includes(method)),
      JSON.stringify(wire),
    );
  } finally {
    await daemon.release();
  }
});

test("the first real Pi RPC daemon status repairs idle heartbeat expiry in the same session", async () => {
  const retained = await daemon.expire(true);
  assert.ok(retained.some(({ id, pid }) => id === attached.id && pid === client.child.pid));
  try {
    await checkedDaemonStatus();
    const wire = (await daemon.inspect()).slice(before);
    const update = wire.findIndex(
      ({ method, error }) => method === "update" && error?.name === "ClientContactExpiredError",
    );
    const resume = wire.findIndex(({ method }) => method === "resume-contact");
    assert.ok(update >= 0 && resume > update, JSON.stringify(wire));
    assert.ok(
      wire.every(({ method, contact }) => method !== "poll" || contact !== "expired"),
      "Background polling must not trigger this repair",
    );
  } finally {
    await daemon.release();
  }
  await checkedCommand("/sync status", "remote: empty");
  const wire = await checkSameSession();
  assert.deepEqual(
    wire.filter(({ method }) => method === "submit").map(({ operation }) => operation),
    ["status"],
  );
  assert.ok(fixture.storage.requests.every(({ method }) => method === "GET" || method === "PROPFIND"));
});

test("real Pi RPC recovery does not replay a push interrupted by heartbeat expiry", async () => {
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let gateRead = true;
  fixture.storage.options.beforeRequest = async ({ method }, signal) => {
    if (!gateRead || method !== "GET") return;
    gateRead = false;
    read.resolve();
    const aborted = Promise.withResolvers<void>();
    const abort = () => aborted.resolve();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([release.promise, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const push = client.command("/sync push --yes", () => false);
  let id: string | undefined;
  try {
    await Promise.race([
      read.promise,
      push.then(() => {
        throw new Error("Push finished before reaching the gated WebDAV read");
      }),
    ]);
    const pushes = (await daemon.inspect()).filter(
      ({ method, operation }) => method === "submit" && operation === "push",
    );
    assert.equal(pushes.length, 1);
    id = pushes[0]?.id;
    assert.ok(id);
    const retained = await daemon.expire();
    assert.ok(retained.some(({ id }) => id === attached.id));
    assert.equal((await push).disposition, "handled");
  } finally {
    release.resolve();
  }
  await vi.waitFor(
    async () => {
      const wire = (await daemon.inspect()).slice(before);
      assert.ok(wire.some(({ method, job }) => method === "poll" && job?.id === id && job?.phase === "failed"));
      assert.ok(
        wire.some(({ method, contact }) => method === "poll" && contact === "expired"),
        "No poll observed expiry",
      );
      assert.ok(
        wire.some(({ method, error }) => method === "resume-contact" && !error),
        "Contact was not repaired before the next command",
      );
    },
    { timeout: 1_500 },
  );
  await checkedDaemonStatus();
  await checkedCommand("/sync status", "remote: empty");
  await checkSameSession();
  await client.close();
  const wire = (await daemon.inspect()).slice(before);
  const transfer = wire.filter(
    ({ method, operation }) =>
      method === "submit" && ["push", "pull", "sync", "startup-transfer"].includes(operation ?? ""),
  );
  assert.deepEqual(
    transfer.map((item) => [item.operation, item.id]),
    [["push", id]],
  );
  assert.ok(fixture.storage.requests.every(({ method }) => method === "GET" || method === "PROPFIND"));
  assert.equal(fixture.storage.resources.size, 0);
});

test.each(["before-accept", "after-accept"] as const)(
  "real Pi RPC completes the original pull silently after a queue-release answer is dropped %s",
  async (fault) => {
    const file = path.join(fixture.agent, "AGENTS.md");
    const remote = await fs.readFile(file, "utf8");
    await checkedCommand("/sync push --yes", "Pushed 1 files");
    await fs.writeFile(file, "Synthetic local instructions before pull.\n");
    const initialInstalls = await daemon.installs();
    const storageFrom = fixture.storage.requests.length;
    const wireFrom = (await daemon.inspect()).length;
    const outputFrom = client.records.length;
    await daemon.dropQueueRelease(fault);

    const pull = checkedCommand("/sync pull --force --yes", "Pulled 1 files");
    void pull.catch(() => {});
    // Tie success to a terminal poll of the original job, not to the transport's retry outcome.
    const terminal = await vi.waitFor(
      async () => {
        const wire = (await daemon.inspect()).slice(wireFrom);
        const submitted = wire.find(({ method, operation }) => method === "submit" && operation === "pull");
        const dropped = wire.find(({ release }) => release?.dropped === fault);
        assert.ok(submitted?.id && dropped?.release, "No matching pull and injected queue-release fault");
        assert.equal(dropped.release.job, submitted.id);
        const done = wire.find(
          ({ method, job }) => method === "poll" && job?.id === submitted.id && job?.phase === "done",
        );
        assert.ok(done?.job, `Original pull did not complete after ${fault} drop: ${JSON.stringify(dropped)}`);
        return done.job;
      },
      { timeout: 2_000 },
    );
    await pull;
    await checkedDaemonStatus();
    await checkedCommand("/sync status", "local changed since last sync: no");
    await sameSessionWire();
    await client.close();
    const wire = (await daemon.inspect()).slice(wireFrom);
    const submissions = wire.filter(({ method, operation }) => method === "submit" && operation !== "shutdown");
    assert.deepEqual(
      submissions.map(({ operation }) => operation),
      ["pull", "status"],
    );
    const pullId = submissions[0]?.id;
    assert.ok(pullId);
    assert.deepEqual(terminal, { id: pullId, phase: "done", result: "applied" });

    const answers = wire.filter(({ release }) => release?.job === pullId);
    const [first, retry] = answers;
    assert.ok(first?.id && first.release?.reservation);
    assert.equal(first.release.dropped, fault);
    assert.equal(first.release.accepted, fault === "after-accept");
    for (const { id, release } of answers) {
      assert.equal(id, first.id, "Retry must answer the original callback ID");
      assert.equal(release?.reservation, first.release.reservation);
      assert.equal(release?.client, attached.id);
      assert.equal(release?.value, true);
      assert.equal(release?.error, undefined);
    }
    if (fault === "before-accept") {
      assert.equal(answers.length, 2);
      assert.equal(retry?.release?.accepted, true, JSON.stringify(answers));
    } else {
      // A fresh poll may retire the retained answer before a retry. If the retry
      // does reach the daemon, its stale rejection is not the job result.
      assert.ok(answers.length <= 2, JSON.stringify(answers));
      if (retry) {
        assert.equal(retry.release?.accepted, false);
        assert.match(retry.error?.message ?? "", /Stale or foreign callback response/u);
      }
    }
    assert.equal(await daemon.installs(), initialInstalls + 1, "Pulled instructions must be installed once");
    assert.equal(await fs.readFile(file, "utf8"), remote);
    assert.ok(
      fixture.storage.requests.slice(storageFrom).every(({ method }) => method === "GET" || method === "PROPFIND"),
      "The pull and status must not publish remote writes",
    );
    const output = client.records.slice(outputFrom).filter(({ type }) => type === "extension_ui_request");
    const notifications = output.filter(({ method }) => method === "notify");
    assert.equal(notifications.length, 3, JSON.stringify(notifications));
    assert.match(String(notifications[0]?.message), /^Pulled 1 files from /u);
    assert.match(String(notifications[1]?.message), /^pi-sync-daemon: connected\n/u);
    assert.match(String(notifications[2]?.message), /^sync setup: home\b/u);
    const status = output.filter(({ method, statusKey }) => method === "setStatus" && statusKey === "sync");
    assert.ok(status.length > 0, "No sync status records");
    assert.equal(status.at(-1)?.statusText, undefined);
    assert.ok(
      status.every(({ statusText }) => !/recover|unavailable|reconnect|blocked/iu.test(String(statusText))),
      JSON.stringify(status),
    );
  },
);
