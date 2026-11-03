import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { fixture, integrity } from "./packed-publish-fixture.js";

afterEach(() => vi.useRealTimers());

function untilAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("private provider details", "AbortError")), {
      once: true,
    });
  });
}

test("tarball propagation can outlast six failures without republishing earlier chunks", async () => {
  const f = await fixture();
  f.status(404);
  f.onWait(() => {
    if (f.waits.length === 6) f.status(200);
  });
  await f.execute(["--output", f.output]);
  assert.equal(f.now(), 12_000);
  assert.equal(f.calls.filter((call) => call === "fetch").length, 7);
  assert.equal(f.nativePlans.length, 2);
  assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 2);
});

test("metadata and tarball phases share one budget rather than resetting it", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  f.onWait(() => {
    if (f.waits.length === 6) f.viewResult(undefined);
  });
  let cancelled = false;
  await assert.rejects(
    f.execute([], async () => {
      f.advance(19_000);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    }),
    /deadline exceeded.*operation download tarball.*elapsed 31000 ms.*remaining 0 ms/u,
  );
  assert.equal(f.now(), 31_000);
  assert.ok(cancelled);
  assert.equal(f.calls.filter((call) => call === "view").length, 7);
  assert.deepEqual(f.nativePlans, [[f.releases[0]]]);
});

for (const elapsed of [29_999, 30_000, 30_001]) {
  test(`metadata completion at ${elapsed} ms respects the exact deadline`, async () => {
    const f = await fixture();
    f.onView(() => f.advance(elapsed));
    if (elapsed < 30_000) {
      await f.execute();
      assert.equal(f.calls.at(-1), "@test/consumer");
    } else {
      await assert.rejects(f.execute(), /deadline exceeded.*operation query metadata/u);
      assert.ok(!f.calls.includes("fetch"));
      assert.ok(!f.calls.includes("@test/consumer"));
    }
  });
}

test("logging cannot start a retry wait after the budget expires", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  await assert.rejects(
    f.execute([], f.fetch, { log: () => f.advance(30_000) }),
    /deadline exceeded.*operation retry wait/u,
  );
  assert.deepEqual(f.waits, []);
  assert.equal(f.calls.filter((call) => call === "view").length, 1);
});

test("logging that consumes part of the budget also reduces the actual retry wait", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  await assert.rejects(f.execute([], f.fetch, { log: () => f.advance(29_500) }), /deadline exceeded/u);
  assert.deepEqual(f.waits, [500]);
});

test("verification removes its shutdown handlers before native publication", async () => {
  const f = await fixture();
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await f.execute([], f.fetch, {
    run: async (command: string, args: string[], options: Parameters<typeof f.run>[2]) => {
      if (command !== "npm")
        assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
      return f.run(command, args, options);
    },
  });
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("the final wait is capped and retains the safe last failure diagnostics", async () => {
  const f = await fixture();
  f.onView(() => f.advance(29_500));
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404","detail":"private-token"}}', stderr: "private-token" });
  await assert.rejects(
    f.execute(),
    (error: Error) =>
      /deadline exceeded.*operation retry wait.*attempt 1.*elapsed 30000 ms.*remaining 0 ms.*E404/u.test(
        error.message,
      ) && !error.message.includes("private-token"),
  );
  assert.deepEqual(f.waits, [500]);
  assert.equal(f.calls.filter((call) => call === "view").length, 1);
  assert.match(f.logs[0], /query metadata.*elapsed 29500 ms.*remaining 500 ms.*retrying in 500 ms/u);
  assert.ok(f.logs.every((line) => !line.includes("private-token")));
});

for (const phase of ["metadata", "fetch", "body", "wait"]) {
  test(`a stalled ${phase} is aborted by the owned deadline and cleans staging`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    const ready = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const stall = (value: AbortSignal) => {
      signal = value;
      const pending = untilAbort(value);
      ready.resolve();
      return pending;
    };
    if (phase === "metadata") f.onView(stall);
    if (phase === "wait") f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
    const fetch =
      phase === "fetch" || phase === "body"
        ? async (_url: URL, options: RequestInit) => {
            assert.ok(options.signal);
            if (phase === "fetch") return stall(options.signal);
            return { ok: true, bodyUsed: true, arrayBuffer: () => stall(options.signal as AbortSignal) };
          }
        : f.fetch;
    const overrides =
      phase === "wait"
        ? { wait: (_ms: number, _value: unknown, options: { signal: AbortSignal }) => stall(options.signal) }
        : {};
    const pending = f.execute(["--output", f.output], fetch, overrides);
    const rejected = assert.rejects(
      pending,
      (error: Error) => /deadline exceeded/u.test(error.message) && !error.message.includes("private provider details"),
    );
    await ready.promise;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    await readFile(path.join(f.nativeDirectories[0], "publish-plan.json"));
    f.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(vi.getTimerCount(), 0);
    assert.deepEqual(f.nativePlans, [[f.releases[0]]]);
    assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 1);
    await assert.rejects(readFile(path.join(f.nativeDirectories[0], "publish-plan.json")), { code: "ENOENT" });
  });
}

test("a late successful body cannot permit consumer publication", async () => {
  const f = await fixture();
  await assert.rejects(
    f.execute([], async () => ({
      ok: true,
      bodyUsed: true,
      arrayBuffer: async () => {
        f.advance(30_000);
        return f.bytes[0];
      },
    })),
    /deadline exceeded.*operation read tarball body/u,
  );
  assert.deepEqual(f.nativePlans, [[f.releases[0]]]);
});

test("native publication has no registry signal or deadline, and verification starts afterward", async () => {
  const f = await fixture();
  await f.execute([], f.fetch, {
    run: async (command: string, args: string[], options: Parameters<typeof f.run>[2]) => {
      if (command !== "npm") {
        assert.equal(options.signal, undefined);
        f.advance(40_000);
      }
      return f.run(command, args, options);
    },
  });
  assert.equal(f.now(), 80_000);
  assert.deepEqual(f.nativePlans, [[f.releases[0]], [f.releases[1]]]);
});

test("authentication after an earlier E404 is still terminal", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  f.onWait(() => f.viewResult({ code: 1, stdout: '{"error":{"code":"E401"}}' }));
  await assert.rejects(f.execute(), /E401.*attempt 2.*elapsed 2000 ms/u);
  assert.deepEqual(f.waits, [2_000]);
  assert.equal(f.calls.filter((call) => call === "view").length, 2);
  assert.ok(!f.calls.includes("@test/consumer"));
});

test("integrity failure after a temporary artifact error does not retry", async () => {
  const f = await fixture();
  f.status(404);
  f.onWait(() => {
    f.status(200);
    f.fetchBytes(Buffer.from("wrong artifact"));
  });
  await assert.rejects(f.execute(), /integrity mismatch/u);
  assert.deepEqual(f.waits, [2_000]);
  assert.ok(!f.calls.includes("@test/consumer"));
});

for (const phase of ["headers", "body"]) {
  test(`real HTTP ${phase} stalls are cancelled before staging cleanup`, async () => {
    const f = await fixture();
    const ready = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.once("close", disconnected.resolve);
      if (phase === "body") {
        response.writeHead(200);
        response.flushHeaders();
      } else ready.resolve();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    f.metadata({
      name: "@test/core",
      version: "2.0.0",
      dist: {
        tarball: `http://127.0.0.1:${address.port}/core.tgz`,
        integrity: integrity(f.bytes[0], "sha512"),
      },
    });
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
      if (ms === 30_000 && !expire) expire = () => callback(...args);
      return schedule(callback, ms, ...args);
    });
    let safety: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = f.execute([], async (url: URL, options: RequestInit) => {
        const response = await globalThis.fetch(url, options);
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = () => {
          const body = read();
          ready.resolve();
          return body;
        };
        return response;
      });
      const rejected = assert.rejects(pending, /Registry readiness deadline exceeded/u);
      await ready.promise;
      assert.ok(expire);
      const failed = new Promise<never>((_resolve, reject) => {
        safety = schedule(() => reject(new Error("HTTP abort did not close its connection")), 2_000);
      });
      f.advance(30_000);
      expire();
      await Promise.race([Promise.all([rejected, disconnected.promise]), failed]);
      assert.deepEqual(f.nativePlans, [[f.releases[0]]]);
      assert.deepEqual(f.waits, []);
      await assert.rejects(readFile(path.join(f.nativeDirectories[0], "publish-plan.json")), { code: "ENOENT" });
    } finally {
      clearTimeout(safety);
      timer.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
}

test("unknown subprocess errors stop without exposing exception details", async () => {
  const f = await fixture();
  f.onView(() => {
    throw new Error("https://user:private-token@registry.example");
  });
  await assert.rejects(
    f.execute(),
    (error: Error) => /subprocess failed/u.test(error.message) && !error.message.includes("private-token"),
  );
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.logs, []);
});
