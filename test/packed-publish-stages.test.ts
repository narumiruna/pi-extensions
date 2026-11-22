import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { fixture, integrity } from "./packed-publish-fixture.js";

const prerequisites = ["--stage", "prerequisites"];
const gate = ["--stage", "verify-registry"];
const remaining = ["--stage", "remaining"];
const notFound = { code: 1, stdout: '{"error":{"code":"E404"}}' };

for (const mode of ["both", "consumer-only", "core-only", "tag-only", "empty", "dev-only"] as const) {
  test(`staged publication partitions the ${mode} plan and checks remaining dependencies`, async () => {
    const f = await fixture(mode === "dev-only" ? "devDependencies" : "dependencies");
    const [core, consumer] = f.releases;
    const tagOnly = { name: core.name, version: core.version, kind: "tag-only" };
    const [plan, first, last, verify] = {
      both: [[consumer, core], [core], [consumer], true],
      "consumer-only": [[consumer], [], [consumer], true],
      "core-only": [[core], [], [core], false],
      "tag-only": [[consumer, tagOnly], [tagOnly], [consumer], true],
      empty: [[], [], [], false],
      "dev-only": [[consumer, core], [], [consumer, core], false],
    }[mode] as [typeof f.releases, typeof f.releases, typeof f.releases, boolean];
    await f.save(plan.length ? [plan] : []);
    if (mode === "consumer-only" || mode === "tag-only") {
      const bytes = Buffer.from("different bytes with no packed hash available in this plan");
      f.fetchBytes(bytes);
      f.metadata({
        name: core.name,
        version: core.version,
        dist: {
          tarball: "https://registry.example/core.tgz",
          integrity: integrity(bytes, "sha512"),
        },
      });
    }
    await f.execute([...prerequisites, "--no-git-tag"]);
    assert.deepEqual(
      f.calls,
      first.map(({ name }) => name),
    );
    assert.deepEqual(f.nativeArgs, first.length ? [["--no-git-tag"]] : []);
    f.calls.length = 0;
    await f.execute(gate);
    assert.deepEqual(f.calls, verify ? ["view", "fetch"] : []);
    f.calls.length = 0;
    await f.execute(["--stage=remaining"]);
    assert.deepEqual(f.calls, [...(verify ? ["view", "fetch"] : []), ...last.map(({ name }) => name)]);
    assert.deepEqual(
      f.nativePlans,
      [first, last].filter((chunk) => chunk.length),
    );
    assert.deepEqual(f.waits, []);
  });
}

test("multi-level runtime prerequisites publish in order, while independent entries wait and shared checks deduplicate", async () => {
  const f = await fixture("dependencies", "^2.0.0", [
    { name: "@test/leaf", version: "1.0.0", dependencies: { "@test/consumer": "^3.0.0", "@test/core": "^2.0.0" } },
    { name: "@test/other-leaf", version: "1.0.0", peerDependencies: { "@test/core": "^2.0.0" } },
    { name: "@test/independent", version: "1.0.0" },
  ]);
  const [core, middle, leaf, otherLeaf, independent] = f.releases;
  await f.save([[leaf, otherLeaf, independent, middle, core]]);
  await f.execute(prerequisites);
  assert.deepEqual(f.calls, [core.name, "view", "fetch", middle.name]);
  f.calls.length = 0;
  await f.execute(gate);
  assert.deepEqual(f.calls, ["view", "fetch", "view @test/consumer@3.0.0", "fetch @test/consumer"]);
  const verified = f.calls.splice(0);
  await f.execute(remaining);
  assert.deepEqual(f.calls, [...verified, independent.name, otherLeaf.name, leaf.name]);
  assert.deepEqual(f.nativePlans, [[core], [middle], [independent, otherLeaf, leaf]]);
});

for (const stage of [prerequisites, gate, remaining]) {
  test(`${stage[1]} validates the entire plan before selection`, async () => {
    const f = await fixture();
    const coreManifest = path.join(f.cwd, "packages/0/package.json");
    const [core, consumer] = f.releases;
    await writeFile(
      coreManifest,
      JSON.stringify({
        name: core.name,
        version: core.version,
        optionalDependencies: { [consumer.name]: `^${consumer.version}` },
      }),
    );
    await assert.rejects(f.execute(stage), /Cyclic runtime dependencies/u);
    await writeFile(coreManifest, JSON.stringify({ name: core.name, version: core.version }));
    for (const { tarball } of f.releases) {
      assert.ok(tarball);
      const file = path.join(f.pack, tarball.path);
      await writeFile(file, "tampered");
      await assert.rejects(f.execute(stage), /Local artifact integrity mismatch/u);
      await writeFile(file, f.bytes[f.releases.findIndex((release) => release.tarball === tarball)]);
    }
    assert.deepEqual(f.calls, []);
  });
}

test.each([
  ["--stage"],
  ["--stage="],
  ["--stage=all"],
  ["--stage", "--no-git-tag"],
  ["--stage=prerequisites", "--stage=remaining"],
  ["--no-stage"],
  ["--stage.mode=remaining"],
  ["-stage", "remaining"],
  ["--", "--stage=remaining"],
  ["--", "--from-pack-dir=x"],
  ["--stage=verify-registry", "--no-git-tag"],
])("rejects ambiguous or invalid guard arguments %j", async (...args: string[]) => {
  const f = await fixture();
  await assert.rejects(f.execute(args), /--stage|--from-pack-dir/u);
  assert.deepEqual(f.calls, []);
});

test("the read-only stage accepts visibility after the publish jobs' short deadline", async () => {
  const f = await fixture();
  f.viewResult(notFound);
  await assert.rejects(f.execute(remaining), /elapsed 30000 ms/u);
  assert.deepEqual(f.waits, Array(15).fill(2_000));
  f.waits.length = 0;
  f.onWait(() => {
    if (f.waits.length === 7) f.viewResult(undefined);
  });
  await f.execute(gate);
  assert.equal(f.now(), 65_000);
  assert.deepEqual(f.waits, Array(7).fill(5_000));
  assert.deepEqual(f.nativePlans, []);
});

test("the gate stops after five minutes of repeated E404s without invoking native publish", async () => {
  const f = await fixture();
  f.viewResult(notFound);
  await assert.rejects(f.execute(gate), /deadline exceeded.*attempt 60.*elapsed 300000 ms.*E404/u);
  assert.deepEqual(f.waits, Array(60).fill(5_000));
  assert.deepEqual(f.calls, Array(60).fill("view"));
});

test("metadata, download, body, and capped retry waits share the gate's deadline", async () => {
  const f = await fixture();
  f.onView(() => f.advance(290_000));
  let bodiesCancelled = 0;
  await assert.rejects(
    f.execute(gate, async () => {
      f.advance(7_000);
      return new Response(
        new ReadableStream({
          cancel: () => {
            bodiesCancelled++;
          },
        }),
        { status: 404 },
      );
    }),
    /deadline exceeded.*operation retry wait.*elapsed 300000 ms/u,
  );
  assert.equal(bodiesCancelled, 1);
  assert.deepEqual(f.waits, [3_000]);
  assert.deepEqual(f.nativePlans, []);
});

test("an expired gate rejects an otherwise valid body", async () => {
  const f = await fixture();
  f.onView(() => f.advance(299_000));
  await assert.rejects(
    f.execute(gate, async () => ({
      ok: true,
      bodyUsed: true,
      arrayBuffer: async () => {
        f.advance(1_000);
        return f.bytes[0];
      },
    })),
    /deadline exceeded.*operation read tarball body.*elapsed 300000 ms/u,
  );
  assert.deepEqual(f.nativePlans, []);
});

for (const [failure, expected] of [
  ["auth", /E401/u],
  ["metadata", /Invalid registry metadata/u],
  ["url", /Invalid registry artifact URL/u],
  ["integrity", /integrity mismatch/u],
  ["packed hash", /differs from packed artifact/u],
] as const) {
  test(`the gate fails fast on ${failure}`, async () => {
    const f = await fixture();
    const expectedBytes = f.bytes[0];
    const differentBytes = Buffer.from("different artifact");
    if (failure === "auth") f.viewResult({ code: 1, stdout: '{"error":{"code":"E401"}}' });
    if (failure === "metadata") f.viewResult({ code: 0, stdout: "not JSON" });
    if (failure === "integrity" || failure === "packed hash") f.fetchBytes(differentBytes);
    f.metadata({
      name: "@test/core",
      version: "2.0.0",
      dist: {
        tarball:
          failure === "url"
            ? "https://user:private-token@registry.example/core.tgz"
            : "https://registry.example/core.tgz",
        integrity: integrity(failure === "packed hash" ? differentBytes : expectedBytes, "sha512"),
      },
    });
    await assert.rejects(
      f.execute(gate),
      (error: Error) => expected.test(error.message) && !error.message.includes("private-token"),
    );
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.nativePlans, []);
    if (failure === "auth" || failure === "metadata" || failure === "url") assert.deepEqual(f.calls, ["view"]);
  });
}

test.each([{}, "", "md5-unrecognized", "sha512-invalid"])(
  "invalid registry integrity %j fails before requesting a missing tarball",
  async (sri) => {
    const f = await fixture();
    f.metadata({
      name: "@test/core",
      version: "2.0.0",
      dist: { tarball: "https://registry.example/core.tgz", integrity: sri },
    });
    f.status(404);
    await assert.rejects(f.execute(gate), /Invalid registry metadata/u);
    assert.deepEqual(f.calls, ["view"]);
    assert.deepEqual(f.waits, []);
  },
);

test("the gate owns and releases a five-minute abort timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = await fixture();
    const ready = Promise.withResolvers<AbortSignal>();
    f.onView(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          ready.resolve(signal);
        }),
    );
    const rejected = assert.rejects(f.execute(gate), /deadline exceeded.*operation query metadata/u);
    const signal = await ready.promise;
    await vi.advanceTimersByTimeAsync(299_999);
    assert.equal(signal.aborted, false);
    f.advance(300_000);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(vi.getTimerCount(), 0);
    assert.deepEqual(f.calls, ["view"]);
  } finally {
    vi.useRealTimers();
  }
});
