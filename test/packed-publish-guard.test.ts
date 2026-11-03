import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "vitest";
import { fixture, integrity, nativeOptions, type Release } from "./packed-publish-fixture.js";

const script = "../scripts/publish-packed-packages.mjs";
const { publishPackedPackages } = await import(script);

for (const status of [200, 404]) {
  test(`production fetch verifies exact artifact over local HTTP (${status})`, async () => {
    const f = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(status);
      response.end(f.bytes[0]);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      f.metadata({
        name: "@test/core",
        version: "2.0.0",
        dist: {
          tarball: `http://127.0.0.1:${address.port}/core.tgz`,
          integrity: integrity(f.bytes[0], "sha512"),
        },
      });
      if (status === 200) {
        await f.execute([], globalThis.fetch);
        assert.equal(f.calls.at(-1), "@test/consumer");
      } else {
        await assert.rejects(f.execute([], globalThis.fetch), /artifact unavailable/u);
        assert.ok(!f.calls.includes("@test/consumer"));
      }
      assert.equal(requests, status === 200 ? 1 : 15);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
}

test("guard chunks preserve packed entries, paths, bytes, forwarded args and simulated report events", async () => {
  const f = await fixture();
  await f.execute(["--output", f.output, "--otp", "123456"]);
  assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  assert.deepEqual(f.nativePlans, [[f.releases[0]], [f.releases[1]]]);
  assert.deepEqual(f.nativeArgs, Array(2).fill(["--output", f.output, "--otp", "123456"]));
  assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 2);
});

test("metadata propagation longer than the old six-attempt window still permits consumers", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  f.onWait(() => {
    if (f.waits.length === 6) f.viewResult(undefined);
  });
  await f.execute();
  assert.deepEqual(f.waits, Array(6).fill(2_000));
  assert.equal(f.calls.filter((call) => call === "view").length, 7);
  assert.deepEqual(f.nativePlans, [[f.releases[0]], [f.releases[1]]]);
});

test("metadata can become available on the last attempt without republishing earlier chunks", async () => {
  const f = await fixture();
  f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
  f.onWait(() => {
    if (f.waits.length === 14) f.viewResult(undefined);
  });
  await f.execute(["--output", f.output]);
  assert.deepEqual(f.waits, Array(14).fill(2_000));
  assert.equal(f.calls.filter((call) => call === "view").length, 15);
  assert.deepEqual(f.nativePlans, [[f.releases[0]], [f.releases[1]]]);
  assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 2);
  assert.match(f.logs[13], /E404.*attempt 14.*elapsed 26000 ms.*remaining 4000 ms.*retrying in 2000 ms/u);
  for (const directory of f.nativeDirectories)
    await assert.rejects(readFile(path.join(directory, "publish-plan.json")), { code: "ENOENT" });
});

for (const code of [
  "E404",
  "E408",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "E599",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNECTIONTIMEOUT",
  "EIDLETIMEOUT",
  "ERESPONSETIMEOUT",
  "ETRANSFERTIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]) {
  test(`temporary npm ${code} retries exact metadata before consumers`, async () => {
    const f = await fixture();
    f.viewResult({ code: 1, stdout: JSON.stringify({ error: { code } }) });
    f.onWait(() => f.viewResult(undefined));
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "view", "fetch", "@test/consumer"]);
    assert.deepEqual(f.waits, [2_000]);
    assert.ok(f.logs[0].includes(code));
  });
}

for (const stdout of [
  '{"error":{"code":"E401"}}',
  '{"error":{"code":"E403"}}',
  '{"error":{"code":"ENEEDAUTH"}}',
  '{"error":{"code":"E400"}}',
  '{"error":{"code":"EINVALIDCONFIG"}}',
  '{"error":{"code":"E404\\nsecret"}}',
  "invalid secret",
  "{}",
  "null",
]) {
  test(`terminal npm error ${stdout} stops without retries or raw diagnostics`, async () => {
    const f = await fixture();
    f.viewResult({ code: 1, stdout, stderr: "https://user:secret@registry.example/private-token" });
    await assert.rejects(
      f.execute(),
      (error: Error) =>
        /Registry metadata unavailable.*npm exit 1.*attempt 1/u.test(error.message) &&
        !error.message.includes("secret"),
    );
    assert.deepEqual(f.calls, ["@test/core", "view"]);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.logs, []);
  });
}

for (const status of [404, 408, 429, 500, 502, 503, 504, 599]) {
  test(`temporary artifact HTTP ${status} retries metadata and bytes`, async () => {
    const f = await fixture();
    f.status(status);
    f.onWait(() => f.status(200));
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "view", "fetch", "@test/consumer"]);
    assert.deepEqual(f.waits, [2_000]);
    assert.ok(f.logs[0].includes(`(${status})`));
  });
}

for (const status of [301, 302, 400, 401, 403, 410]) {
  test(`terminal artifact HTTP ${status} stops without retry`, async () => {
    const f = await fixture();
    f.status(status);
    await assert.rejects(f.execute(), /Registry artifact unavailable/u);
    assert.deepEqual(f.waits, []);
    assert.ok(!f.calls.includes("@test/consumer"));
  });
}

for (const phase of ["fetch", "body"]) {
  for (const failure of [
    Object.assign(new Error("private URL"), { code: "ECONNRESET" }),
    new TypeError("private URL", { cause: { code: "UND_ERR_SOCKET" } }),
    new DOMException("private URL", "TimeoutError"),
  ]) {
    test(`temporary ${phase} ${failure.name} retries without exposing errors`, async () => {
      const f = await fixture();
      let attempts = 0;
      await f.execute([], async () => {
        attempts++;
        if (attempts > 1) return new Response(f.bytes[0]);
        if (phase === "fetch") throw failure;
        return {
          ok: true,
          arrayBuffer: async () => {
            throw failure;
          },
        };
      });
      assert.equal(attempts, 2);
      assert.deepEqual(f.waits, [2_000]);
      assert.ok(!f.logs[0].includes("private URL"));
      assert.equal(f.calls.at(-1), "@test/consumer");
    });
  }
}

test("retry releases an unsuccessful response body before waiting", async () => {
  const f = await fixture();
  let cancelled = false;
  let attempts = 0;
  f.onWait(() => assert.ok(cancelled));
  await f.execute([], async () => {
    attempts++;
    return attempts > 1
      ? new Response(f.bytes[0])
      : new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 404 },
        );
  });
  assert.equal(attempts, 2);
  assert.deepEqual(f.waits, [2_000]);
});

for (const phase of ["metadata", "artifact"]) {
  test(`exhausted ${phase} retries block consumers and clean staging with prior reports intact`, async () => {
    const f = await fixture();
    if (phase === "metadata") f.viewResult({ code: 1, stdout: '{"error":{"code":"E404","detail":"secret"}}' });
    else f.status(404);
    await assert.rejects(
      f.execute(["--output", f.output]),
      (error: Error) =>
        /Registry readiness deadline exceeded.*attempt 15.*elapsed 30000 ms/u.test(error.message) &&
        !error.message.includes("secret"),
    );
    assert.equal(f.calls.filter((call) => call === "view").length, 15);
    assert.deepEqual(f.waits, Array(15).fill(2_000));
    assert.equal(f.logs.length, 15);
    assert.ok(f.logs.every((line) => !line.includes("secret")));
    assert.deepEqual(f.nativePlans, [[f.releases[0]]]);
    assert.equal((await readFile(f.output, "utf8")).trim().split("\n").length, 1);
    await assert.rejects(readFile(path.join(f.nativeDirectories[0], "publish-plan.json")), { code: "ENOENT" });
  });
}

test("a failed retry wait stops and removes staging before another query", async () => {
  const f = await fixture();
  f.status(404);
  f.onWait(() => {
    throw new Error("wait interrupted");
  });
  await assert.rejects(f.execute(), /Registry retry wait failed/u);
  assert.deepEqual(f.calls, ["@test/core", "view", "fetch"]);
  assert.deepEqual(f.waits, [2_000]);
  await assert.rejects(readFile(path.join(f.nativeDirectories[0], "publish-plan.json")), { code: "ENOENT" });
});

test("native tag suppression is forwarded unchanged", async () => {
  const f = await fixture();
  await f.execute(["--no-git-tag", "--"]);
  assert.deepEqual(f.nativeArgs, [
    ["--no-git-tag", "--"],
    ["--no-git-tag", "--"],
  ]);
});

for (const range of [
  "workspace:*",
  "workspace:^",
  "workspace:~",
  "workspace:^2.0.0",
  "workspace:~2.0.0",
  "workspace:2.0.0",
  "workspace:>=2.0.0 <3",
  "workspace:packages/0",
  "workspace:./packages/0",
  "workspace:packages/other/../0",
]) {
  test(`native workspace range ${range} gates current internal artifact`, async () => {
    const f = await fixture("dependencies", range);
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  });
}

test("optional dependency ranges take precedence over dependency and peer ranges", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.cwd, "packages/1/package.json"),
    JSON.stringify({
      name: "@test/consumer",
      version: "3.0.0",
      dependencies: { "@test/core": "^2.0.0" },
      peerDependencies: { "@test/core": "^2.0.0" },
      optionalDependencies: { "@test/core": "^1.0.0" },
    }),
  );
  await f.execute();
  assert.ok(!f.calls.includes("view"));
});

test("cyclic runtime releases fail before native publication", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.cwd, "packages/0/package.json"),
    JSON.stringify({
      name: "@test/core",
      version: "2.0.0",
      dependencies: { "@test/consumer": "^3.0.0" },
    }),
  );
  await assert.rejects(f.execute(), /Cyclic/u);
  assert.deepEqual(f.calls, []);
});

test("registry integrity uses strongest supported SRI algorithm", async () => {
  const f = await fixture();
  f.metadata({
    name: "@test/core",
    version: "2.0.0",
    dist: {
      tarball: "https://registry.example/core.tgz",
      integrity: `${integrity(Buffer.from("wrong"), "sha512")} ${integrity(f.bytes[0], "sha1")}`,
    },
  });
  await assert.rejects(f.execute(), /integrity mismatch/u);
  assert.ok(!f.calls.includes("@test/consumer"));
});

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`${field} requires exact registry availability`, async () => {
    const f = await fixture(field);
    await f.execute();
    assert.deepEqual(f.calls, ["@test/core", "view", "fetch", "@test/consumer"]);
  });
}
for (const [field, range] of [
  ["devDependencies", "^2.0.0"],
  ["dependencies", "^1.0.0"],
  ["dependencies", "invalid-range"],
  ["dependencies", "file:../0"],
  ["dependencies", "link:../0"],
  ["dependencies", "npm:@test/core@2.0.0"],
  ["dependencies", "workspace:^1.0.0"],
  ["dependencies", "workspace:invalid-range"],
]) {
  test(`${field} ${range} does not gate unrelated versions`, async () => {
    const f = await fixture(field, range);
    await f.execute();
    assert.equal(f.nativePlans.length, 1);
    assert.ok(!f.calls.includes("view"));
  });
}

for (const mode of ["tag-only", "omitted", "retry"]) {
  test(`${mode} dependencies still require exact registry artifact`, async () => {
    const f = await fixture();
    if (mode === "tag-only") {
      f.releases[0] = { name: "@test/core", version: "2.0.0", kind: "tag-only" };
      await f.save([[f.releases[0]], [f.releases[1]]]);
    } else if (mode === "omitted") await f.save([[f.releases[1]]]);
    f.status(404);
    await assert.rejects(f.execute(), /artifact unavailable/u);
    assert.ok(f.calls.includes("view"));
    assert.ok(!f.calls.includes("@test/consumer"));
  });
}

test("tag-only and absent-plan dependencies succeed with registry SRI without a local packed artifact", async () => {
  for (const tagOnly of [false, true]) {
    const f = await fixture();
    const core: Release = { name: "@test/core", version: "2.0.0", kind: "tag-only" };
    await f.save(tagOnly ? [[core], [f.releases[1]]] : [[f.releases[1]]]);
    await f.execute();
    assert.ok(f.calls.includes("fetch"));
    assert.equal(f.calls.at(-1), "@test/consumer");
  }
});

for (const failure of [
  "empty-metadata",
  "metadata-404",
  "wrong-version",
  "wrong-name",
  "missing-dist",
  "file-url",
  "invalid-url",
  "missing-integrity",
  "artifact-404",
  "sri-mismatch",
  "local-mismatch",
]) {
  test(`blocks consumers on ${failure} and retains earlier native report events`, async () => {
    const f = await fixture();
    const dist = { tarball: "https://registry.example/core.tgz", integrity: integrity(f.bytes[0], "sha512") };
    switch (failure) {
      case "empty-metadata":
        f.viewResult({ code: 0, stdout: "" });
        break;
      case "metadata-404":
        f.viewResult({ code: 1, stdout: '{"error":{"code":"E404"}}' });
        break;
      case "wrong-version":
        f.metadata({ name: "@test/core", version: "1.0.0", dist });
        break;
      case "wrong-name":
        f.metadata({ name: "other", version: "2.0.0", dist });
        break;
      case "missing-dist":
        f.metadata({ name: "@test/core", version: "2.0.0" });
        break;
      case "file-url":
        dist.tarball = "file:///tmp/package.tgz";
        break;
      case "invalid-url":
        dist.tarball = "not a URL";
        break;
      case "missing-integrity":
        dist.integrity = "";
        break;
      case "artifact-404":
        f.status(404);
        break;
      case "sri-mismatch":
        f.fetchBytes(Buffer.from("corrupt bytes"));
        break;
      case "local-mismatch": {
        const different = Buffer.from("different but registry-consistent bytes");
        f.fetchBytes(different);
        dist.integrity = integrity(different, "sha512");
        break;
      }
    }
    if (["file-url", "invalid-url", "missing-integrity", "local-mismatch"].includes(failure))
      f.metadata({ name: "@test/core", version: "2.0.0", dist });
    await assert.rejects(f.execute(["--output", f.output]));
    assert.deepEqual(f.waits, ["metadata-404", "artifact-404"].includes(failure) ? Array(15).fill(2_000) : []);
    assert.ok(!f.calls.includes("@test/consumer"));
    const events = (await readFile(f.output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "git-tag");
    assert.equal(events[0].packageName, "@test/core");
  });
}

test("failed native publication stops before registry queries or consumer invocation", async () => {
  const f = await fixture();
  f.publishCode(1);
  await assert.rejects(f.execute(), /publish failed/u);
  assert.deepEqual(f.calls, ["@test/core"]);
});

for (const failure of [
  "tampered",
  "missing",
  "unsafe",
  "absolute",
  "wrong-version",
  "invalid-plan",
  "missing-plan",
  "missing-tarball",
]) {
  test(`local ${failure} fails preflight before any native invocation`, async () => {
    const f = await fixture();
    const consumer = f.releases[1];
    switch (failure) {
      case "tampered":
        await writeFile(path.join(f.pack, consumer.tarball?.path ?? ""), "tampered");
        break;
      case "missing":
        await rm(path.join(f.pack, consumer.tarball?.path ?? ""));
        break;
      case "unsafe":
        if (consumer.tarball) consumer.tarball.path = "../escape.tgz";
        await f.save();
        break;
      case "absolute":
        if (consumer.tarball) consumer.tarball.path = "/tmp/escape.tgz";
        await f.save();
        break;
      case "wrong-version":
        consumer.version = "1.0.0";
        await f.save();
        break;
      case "invalid-plan":
        await f.save(undefined, 2);
        break;
      case "missing-plan":
        await rm(path.join(f.pack, "publish-plan.json"));
        break;
      case "missing-tarball":
        delete consumer.tarball;
        await f.save();
        break;
    }
    await assert.rejects(f.execute());
    assert.deepEqual(f.calls, []);
  });
}

for (const invalid of [null, {}, { version: 1, plan: [null] }, { version: 1, plan: [[null]] }]) {
  test(`rejects malformed plan ${JSON.stringify(invalid)} before any native invocation`, async () => {
    const f = await fixture();
    await writeFile(path.join(f.pack, "publish-plan.json"), JSON.stringify(invalid));
    await assert.rejects(f.execute());
    assert.deepEqual(f.calls, []);
  });
}

test("duplicate release entries fail before native publication", async () => {
  const f = await fixture();
  await f.save([[f.releases[0]], [f.releases[0], f.releases[1]]]);
  await assert.rejects(f.execute(), /Invalid release/u);
  assert.deepEqual(f.calls, []);
});

for (const spelling of ["from-pack-dir", "fromPackDir", "from-packDir", "fromPack-dir"]) {
  for (const negated of [false, true]) {
    for (const equals of [false, true]) {
      const flag = `--${negated ? "no-" : ""}${spelling}`;
      const override = equals ? [`${flag}=replacement`] : negated ? [flag] : [flag, "replacement"];
      test(`rejects packed override ${override.join(" ")} before any native invocation`, async () => {
        const f = await fixture();
        // Use installed CAC, not a first-canonical-argument stub. Negated = forms are
        // rejected conservatively too, although MRI retains = in their key.
        if (!negated || !equals) {
          const parsed = nativeOptions(["--from-pack-dir", "guarded", ...override]);
          assert.notEqual(parsed.fromPackDir, "guarded");
          if (negated) assert.equal(parsed.fromPackDir, false);
        }
        await assert.rejects(f.execute(override), /canonical|Duplicate/u);
        assert.deepEqual(f.calls, []);
      });
    }
  }
}

test("one canonical equals argument preserves unrelated native arguments", async () => {
  const f = await fixture();
  // Exercise equals input separately from fixture.execute's canonical pair.
  await assert.rejects(
    publishPackedPackages([`--from-pack-dir=${f.pack}`, "--no-fromPackDir"], {
      cwd: f.cwd,
      run: () => assert.fail("must reject before invoking native CLI"),
    }),
    /canonical/u,
  );
  await f.executeEquals(["--output", f.output, "--otp=123456", "--no-git-tag", "--", "positional"]);
  assert.deepEqual(
    f.nativeArgs,
    Array(2).fill(["--output", f.output, "--otp=123456", "--no-git-tag", "--", "positional"]),
  );
});

for (const range of ["workspace:.", "workspace:*", "^1.0.0"]) {
  test(`root workspace reference ${range} fails closed before publication`, async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.cwd, "package.json"),
      JSON.stringify({ name: "test-root", version: "1.0.0", private: true, workspaces: ["packages/*"] }),
    );
    await writeFile(
      path.join(f.cwd, "packages/1/package.json"),
      JSON.stringify({ name: "@test/consumer", version: "3.0.0", dependencies: { "test-root": range } }),
    );
    await assert.rejects(f.execute(), /root runtime dependency/u);
    assert.deepEqual(f.calls, []);
  });
}

test("runtime graph policy matches the current root config", async () => {
  const config = JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"));
  assert.equal(config.bumpVersionsWithWorkspaceProtocolOnly, false);
});

test("registry parse and fetch errors do not expose metadata or URLs", async () => {
  for (const failure of ["json", "fetch", "body", "abort", "redirect"]) {
    const f = await fixture();
    const secret = "https://user:secret@registry.example/private-token";
    if (failure === "json") f.viewResult({ code: 0, stdout: `invalid ${secret}` });
    await assert.rejects(
      f.execute([], async () => {
        if (failure === "body")
          return {
            ok: true,
            arrayBuffer: async () => {
              throw new Error(secret);
            },
          };
        if (failure === "abort") throw new DOMException(secret, "AbortError");
        if (failure === "redirect") throw new TypeError(secret, { cause: new Error("unexpected redirect") });
        throw new Error(secret);
      }),
      (error: Error) => !error.message.includes(secret) && /registry|Registry/u.test(error.message),
    );
    assert.deepEqual(f.waits, []);
    assert.ok(!f.logs.some((line) => line.includes(secret)));
  }
});

test("packed mode is mandatory and duplicate pack paths are rejected", async () => {
  for (const args of [[], ["--from-pack-dir"], ["--from-pack-dir=a", "--from-pack-dir=b"]]) {
    await assert.rejects(publishPackedPackages(args));
  }
});
