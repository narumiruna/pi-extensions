import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { allocateBrowserPort } from "../src/browser-manager.js";
import { browserWebSocketIdentity, waitForBrowserStartup } from "../src/browser-startup.js";

class StartupChild extends EventEmitter {
  stderr = new PassThrough();
}

function start(child: StartupChild, signal = new AbortController().signal, waitMs = 1000) {
  return waitForBrowserStartup(child as unknown as ChildProcess, 9333, waitMs, signal);
}

async function assertReleased(child: StartupChild, signal: AbortSignal) {
  assert.equal(child.listenerCount("spawn"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("end"), 0);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  child.emit("close");
  if (!child.stderr.closed) {
    const closed = once(child.stderr, "close");
    child.stderr.destroy();
    await closed;
  }
  for (const event of ["spawn", "error", "exit", "close"]) assert.equal(child.listenerCount(event), 0, event);
  for (const event of ["data", "end", "error"]) assert.equal(child.stderr.listenerCount(event), 0, event);
  assert.equal(getEventListeners(signal, "abort").length, 0);
}

test("automatic port probes select nonzero ports and release their sockets before returning", async () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    const port = await allocateBrowserPort(host);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host.replace(/^\[(.*)]$/, "$1"), resolve);
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

test("port probe errors are observable and do not poison the next allocation", async () => {
  await assert.rejects(allocateBrowserPort("not:a:valid:address"));
  assert.ok((await allocateBrowserPort("127.0.0.1")) > 0);
});

test("browser identities accept local host aliases and require the selected port and browser target", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]", "[0:0:0:0:0:0:0:1]"]) {
    assert.equal(browserWebSocketIdentity(`ws://${host}:9333/devtools/browser/test`, 9333), "/devtools/browser/test");
  }
  assert.equal(browserWebSocketIdentity("ws://127.0.0.1/devtools/browser/test", 80), "/devtools/browser/test");
  for (const value of [
    undefined,
    null,
    {},
    "not a URL",
    "ws://127.0.0.1:9444/devtools/browser/test",
    "ws://127.0.0.1/devtools/browser/test",
    "wss://127.0.0.1:9333/devtools/browser/test",
    "http://127.0.0.1:9333/devtools/browser/test",
    "ws://remote.example:9333/devtools/browser/test",
    "ws://user:password@127.0.0.1:9333/devtools/browser/test",
    "ws://127.0.0.1:9333/devtools/page/test",
    "ws://127.0.0.1:9333/devtools/browser/",
    "ws://127.0.0.1:9333/devtools/browser/test/extra",
    "ws://127.0.0.1:9333/devtools/browser/test?query=true",
    "ws://127.0.0.1:9333/devtools/browser/test#fragment",
  ])
    assert.equal(browserWebSocketIdentity(value, 9333), undefined, String(value));
});

test("startup collects chunked CRLF announcements and releases every listener", async () => {
  const child = new StartupChild();
  const controller = new AbortController();
  const startup = start(child, controller.signal);
  child.emit("spawn");
  child.stderr.write("A browser diagnostic\nDevTools listen");
  child.stderr.write("ing on ws://127.0.0.1:9333/devtools/browser/te");
  child.stderr.write("st\r\nMore diagnostics\n");
  assert.equal(await startup, "/devtools/browser/test");
  child.stderr.write("x".repeat(128 * 1024));
  await assertReleased(child, controller.signal);
});

test("an announcement before spawn is not published until the spawn handshake", async () => {
  const child = new StartupChild();
  const controller = new AbortController();
  const startup = start(child, controller.signal);
  let settled = false;
  void startup.then(() => {
    settled = true;
  });
  child.stderr.write("DevTools listening on ws://127.0.0.1:9333/devtools/browser/test\n");
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("spawn");
  assert.equal(await startup, "/devtools/browser/test");
  await assertReleased(child, controller.signal);
});

test("startup accepts a final announcement without a newline when stderr ends", async () => {
  const child = new StartupChild();
  const controller = new AbortController();
  const startup = start(child, controller.signal);
  child.emit("spawn");
  child.stderr.end("DevTools listening on ws://127.0.0.1:9333/devtools/browser/test");
  assert.equal(await startup, "/devtools/browser/test");
  await assertReleased(child, controller.signal);
});

test("startup failures release listeners after malformed output, exit, errors, cancellation, and timeout", async () => {
  for (const scenario of [
    {
      pattern: /unexpected DevTools endpoint/,
      trigger: (child: StartupChild) =>
        child.stderr.write("DevTools listening on ws://127.0.0.1:9444/devtools/browser/test\n"),
    },
    {
      pattern: /unexpected DevTools endpoint/,
      trigger: (child: StartupChild) => child.stderr.write("DevTools listening on not-a-websocket\n"),
    },
    { pattern: /exceeded 64 KB/, trigger: (child: StartupChild) => child.stderr.write("x".repeat(64 * 1024 + 1)) },
    { pattern: /closed stderr/, trigger: (child: StartupChild) => child.stderr.end("no announcement") },
    { pattern: /exited before/, trigger: (child: StartupChild) => child.emit("exit", 1) },
    { pattern: /exited before/, trigger: (child: StartupChild) => child.emit("close", 1) },
    { pattern: /spawn failed/, trigger: (child: StartupChild) => child.emit("error", new Error("spawn failed")) },
    {
      pattern: /stream failed/,
      trigger: (child: StartupChild) => child.stderr.emit("error", new Error("stream failed")),
    },
    { pattern: /cancelled/, trigger: (_child: StartupChild, controller: AbortController) => controller.abort() },
    { pattern: /Timed out/, trigger: () => undefined },
  ]) {
    const child = new StartupChild();
    const controller = new AbortController();
    const startup = start(child, controller.signal, 0);
    const rejected = assert.rejects(startup, scenario.pattern);
    child.emit("spawn");
    scenario.trigger(child, controller);
    await rejected;
    await assertReleased(child, controller.signal);
  }
});

test("late process and pipe errors stay handled after cancellation, timeout, and readiness until close", async () => {
  for (const phase of ["cancel-before-spawn", "timeout", "ready"]) {
    const child = new StartupChild();
    const controller = new AbortController();
    const startup = start(child, controller.signal, 0);
    if (phase === "cancel-before-spawn") {
      const rejected = assert.rejects(startup, /cancelled/);
      controller.abort();
      await rejected;
    } else {
      child.emit("spawn");
      if (phase === "ready") {
        child.stderr.write("DevTools listening on ws://127.0.0.1:9333/devtools/browser/test\n");
        assert.equal(await startup, "/devtools/browser/test");
      } else {
        await assert.rejects(startup, /Timed out/);
      }
    }
    for (let index = 0; index < 2; index += 1) {
      assert.doesNotThrow(() => child.emit("error", new Error("late process error")));
      assert.doesNotThrow(() => child.stderr.emit("error", new Error("late pipe error")));
    }
    await assertReleased(child, controller.signal);
  }
});

test("already cancelled startup and missing stderr fail without starting startup work", async () => {
  const child = new StartupChild();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => start(child, controller.signal), { name: "AbortError" });
  assert.doesNotThrow(() => child.emit("error", new Error("late spawn failure")));
  await assertReleased(child, controller.signal);
  const missingStderr = new EventEmitter();
  await assert.rejects(
    waitForBrowserStartup(missingStderr as ChildProcess, 9333, 1000, new AbortController().signal),
    /no startup stderr/,
  );
  assert.doesNotThrow(() => missingStderr.emit("error", new Error("late spawn failure")));
  missingStderr.emit("close");
  assert.equal(missingStderr.listenerCount("error"), 0);
});
