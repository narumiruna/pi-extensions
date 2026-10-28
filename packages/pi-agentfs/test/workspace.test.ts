import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AgentFS, Filesystem } from "agentfs-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDatabasePath, virtualPath } from "../src/paths.js";
import { createWorkspaceTools, SHELL_COMMANDS, SHELL_LIMITS } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

const roots: string[] = [];
const workspaces: Workspace[] = [];
const ctx = { cwd: "/host-must-not-be-used", sessionManager: {} } as ExtensionToolContext;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-agentfs-test-"));
  roots.push(dir);
  const path = join(dir, "workspace.db");
  const workspace = new Workspace(path);
  workspaces.push(workspace);
  await workspace.open();
  const tools = createWorkspaceTools(() => workspace);
  const call = (name: string, args: unknown, signal?: AbortSignal) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute("test", args, signal, undefined, ctx);
  };
  return { dir, path, workspace, call };
}
function output(result: Awaited<ReturnType<ReturnType<typeof createWorkspaceTools>[number]["execute"]>>) {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("virtual paths and file operations", () => {
  it.each([undefined, "", " ", "relative.db", "../a.db", "/a\0.db"])("rejects unapproved database path %j", (path) => {
    expect(() => validateDatabasePath(path)).toThrow(/absolute database path/);
  });
  it.each([
    ["notes/a", "/notes/a"],
    ["/notes/a", "/notes/a"],
    ["../../a", "/a"],
    ["~/a", "/a"],
    ["~", "/"],
    ["@a", "/@a"],
    ["file:///a", "/file:/a"],
  ])("normalizes %s to %s", (path, expected) => {
    expect(virtualPath(path)).toBe(expected);
  });
  it.each(["", "a\0b", "~another/a"])("rejects invalid virtual path %j", (path) => {
    expect(() => virtualPath(path)).toThrow();
  });
  it("requires an existing host parent and never creates it", async () => {
    const { dir } = await fixture();
    const workspace = new Workspace(join(dir, "missing", "a.db"));
    workspaces.push(workspace);
    await expect(workspace.open()).rejects.toThrow(/initialization failed/);
    await expect(workspace.run(undefined, async (fs) => fs.readFile("/x"))).rejects.toThrow(/not ready/);
    await expect(readFile(join(dir, "missing", "a.db"))).rejects.toThrow();
    await workspace.close();
    await workspace.close();
  });
  it("creates, overwrites, paginates, and returns exact edit diffs", async () => {
    const { call } = await fixture();
    await call("write", { path: "notes/a", content: "old\nsecond\nthird" });
    expect(output(await call("read", { path: "/notes/a", offset: 2, limit: 1 }))).toBe(
      "second\n\n[1 more lines in file. Use offset=3 to continue.]",
    );
    const edited = await call("edit", { path: "notes/a", edits: [{ oldText: "old", newText: "new" }] });
    expect(edited.details).toMatchObject({ firstChangedLine: 1, diff: expect.stringContaining("+1 new") });
    expect(output(await call("read", { path: "/notes/a" }))).toBe("new\nsecond\nthird");
    await call("write", { path: "notes/a", content: "replacement" });
    expect(output(await call("bash", { command: "cat /notes/a" }))).toBe("replacement");
    await expect(call("edit", { path: "/notes/a", edits: [{ oldText: "missing", newText: "bad" }] })).rejects.toThrow();
    expect(output(await call("read", { path: "/notes/a" }))).toBe("replacement");
    await expect(call("read", { path: "/missing" })).rejects.toThrow();
    await expect(call("edit", { path: "/missing", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow();
  });
  it("preserves read continuation notices through the registered tool output boundary", async () => {
    const { call } = await fixture();
    await call("write", { path: "/many", content: "line\n".repeat(3000) });
    const result = await call("read", { path: "/many" });
    expect(output(result)).toMatch(/offset=\d+ to continue/);
    expect(result.structuredContent).toBe(output(result));
    expect(output(result).split("\n").length).toBeLessThanOrEqual(2000);
  });
  it("keeps Unicode spaces and @ literal across all four tools", async () => {
    const { call } = await fixture();
    for (const path of ["/@a", "/a\u00a0b", "/c\u202fd", "/é", "/a'b"]) {
      await call("write", { path, content: "first" });
      await call("edit", { path, edits: [{ oldText: "first", newText: "second" }] });
      expect(output(await call("read", { path }))).toBe("second");
      const escaped = path.replaceAll("'", "'\\''");
      expect(output(await call("bash", { command: `cat '${escaped}'` }))).toBe("second");
    }
  });
  it("never selects host files, host home, or the database directory as the virtual root", async () => {
    const { dir, call } = await fixture();
    const decoy = join(dir, "secret.txt");
    await writeFile(decoy, "HOST-SECRET");
    await expect(call("read", { path: decoy })).rejects.toThrow();
    await expect(call("bash", { command: `cat '${decoy}'` })).rejects.toThrow();
    await call("write", { path: decoy, content: "VIRTUAL" });
    expect(output(await call("bash", { command: `cat '${decoy}'` }))).toBe("VIRTUAL");
    await call("edit", { path: decoy, edits: [{ oldText: "VIRTUAL", newText: "EDITED" }] });
    expect(await readFile(decoy, "utf8")).toBe("HOST-SECRET");
    await call("write", { path: "~/home.txt", content: "virtual home" });
    expect(output(await call("bash", { command: "cat ~/home.txt" }))).toBe("virtual home");
    expect(output(await call("read", { path: "../../home.txt" }))).toBe("virtual home");
  });
  it("preserves raw terminal-control filenames in storage, independently of display sanitization", async () => {
    const { call } = await fixture();
    const path = "/notes/\u001b]52;c;c2VjcmV0\u0007name\nline.txt";
    await call("write", { path, content: "raw" });
    await call("edit", { path, edits: [{ oldText: "raw", newText: "unchanged path" }] });
    expect(output(await call("read", { path }))).toBe("unchanged path");
    await expect(call("read", { path: "/notes/nameline.txt" })).rejects.toThrow();
  });
  it("rejects existing native symbolic links without following their host targets", async () => {
    const { path, dir, workspace } = await fixture();
    await workspace.close();
    const decoy = join(dir, "secret.txt");
    await writeFile(decoy, "HOST-SECRET");
    const seed = await AgentFS.open({ path });
    try {
      await seed.fs.symlink(decoy, "/link");
    } finally {
      await seed.close();
    }
    const reopened = new Workspace(path);
    workspaces.push(reopened);
    await reopened.open();
    const tools = createWorkspaceTools(() => reopened);
    for (const [name, input] of [
      ["read", { path: "/link" }],
      ["write", { path: "/link", content: "bad" }],
      ["edit", { path: "/link", edits: [{ oldText: "HOST", newText: "bad" }] }],
      ["bash", { command: "cat /link" }],
      ["bash", { command: "echo bad > /link" }],
      ["bash", { command: "cat /link/child" }],
    ] as const) {
      const tool = tools.find((tool) => tool.name === name);
      await expect(tool?.execute("test", input, undefined, undefined, ctx)).rejects.toThrow();
    }
    expect(await readFile(decoy, "utf8")).toBe("HOST-SECRET");
  });
});

describe("restricted shell and workspace ownership", () => {
  it("shares file content across directory listing, search, pipes, redirects, and edits", async () => {
    const { call } = await fixture();
    await call("write", { path: "/notes/input", content: "alpha\nbeta\nalpha\n" });
    expect(output(await call("bash", { command: "ls /notes; find /notes -type f" }))).toContain("/notes/input");
    await call("bash", { command: "cat /notes/input | grep alpha | sort | uniq > /result" });
    expect(output(await call("read", { path: "/result" }))).toBe("alpha\n");
    await call("edit", { path: "/result", edits: [{ oldText: "alpha", newText: "gamma" }] });
    expect(output(await call("bash", { command: "cat /result" }))).toBe("gamma\n");
    expect(SHELL_COMMANDS).not.toContain("bash");
  });
  it("appends to existing or new files but never truncates data after a storage read failure", async () => {
    const initialize = Filesystem.fromDatabase.bind(Filesystem);
    let failRead = () => {};
    vi.spyOn(Filesystem, "fromDatabase").mockImplementation(async (db, buffer) => {
      const filesystem = await initialize(db, buffer);
      failRead = () => {
        vi.spyOn(filesystem, "readFile").mockRejectedValueOnce(new Error("storage failure"));
      };
      return filesystem;
    });
    const { call } = await fixture();
    await call("write", { path: "/safe", content: "preserved" });
    failRead();
    await expect(call("bash", { command: "echo bad >> /safe" })).rejects.toThrow(/storage failure/);
    expect(output(await call("read", { path: "/safe" }))).toBe("preserved");
    await call("bash", { command: "echo -n appended >> /safe; echo created >> /new" });
    expect(output(await call("read", { path: "/safe" }))).toBe("preservedappended");
    expect(output(await call("read", { path: "/new" }))).toBe("created\n");
  });
  it("does not treat a failed storage existence check as a missing file", async () => {
    const initialize = Filesystem.fromDatabase.bind(Filesystem);
    let failAccess = () => {};
    vi.spyOn(Filesystem, "fromDatabase").mockImplementation(async (db, buffer) => {
      const filesystem = await initialize(db, buffer);
      failAccess = () => {
        vi.spyOn(filesystem, "access").mockRejectedValueOnce(new Error("storage access failure"));
      };
      return filesystem;
    });
    const { workspace, call } = await fixture();
    await call("write", { path: "/present", content: "preserved" });
    failAccess();
    await expect(workspace.run(undefined, (fs) => fs.exists("/present"))).rejects.toThrow(/storage access failure/);
    expect(await workspace.run(undefined, (fs) => fs.exists("/present"))).toBe(true);
    expect(await workspace.run(undefined, (fs) => fs.exists("/missing"))).toBe(false);
  });
  it("isolates two databases and resets shell cwd/environment between calls", async () => {
    const a = await fixture();
    const b = await fixture();
    await Promise.all([
      a.call("write", { path: "/same", content: "A" }),
      b.call("write", { path: "/same", content: "B" }),
    ]);
    await a.call("edit", { path: "/same", edits: [{ oldText: "A", newText: "AA" }] });
    await b.call("bash", { command: "echo BB > /same; mkdir /dir; cd /dir; export PRIVATE=other" });
    expect(output(await a.call("bash", { command: `cat /same; pwd; echo "\${PRIVATE-unset}"` }))).toBe("AA/\nunset\n");
    expect(output(await b.call("bash", { command: `pwd; echo "\${PRIVATE-unset}"` }))).toBe("/\nunset\n");
    await a.workspace.close();
    expect(output(await b.call("read", { path: "/same" }))).toBe("BB\n");
    const reopened = new Workspace(a.path);
    workspaces.push(reopened);
    await reopened.open();
    expect(await reopened.run(undefined, (fs) => fs.readFile("/same"))).toBe("AA");
  });
  it("serializes a complete shell read-modify-write with following edit/write calls", async () => {
    const { workspace, call } = await fixture();
    await call("write", { path: "/counter", content: "A" });
    const entered = deferred();
    const release = deferred();
    const blocker = workspace.run(undefined, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const shell = call("bash", { command: 'old=$(cat /counter); echo -n "$old"B > /counter' });
    const edit = call("edit", { path: "/counter", edits: [{ oldText: "AB", newText: "ABC" }] });
    release.resolve();
    await Promise.all([blocker, shell, edit]);
    expect(output(await call("read", { path: "/counter" }))).toBe("ABC");
    await expect(call("bash", { command: "false" })).rejects.toThrow(/code 1/);
    await call("write", { path: "/counter", content: "queue recovered" });
    expect(output(await call("read", { path: "/counter" }))).toBe("queue recovered");
  });
  it("does not expose process secrets, network, external runtimes, or native command fallback", async () => {
    const { call, dir } = await fixture();
    vi.stubEnv("AGENTFS_SECRET_DECOY", "DO-NOT-EXPOSE");
    const fetch = vi.fn(() => {
      throw new Error("Network must not be used");
    });
    vi.stubGlobal("fetch", fetch);
    expect(output(await call("bash", { command: `echo "\${AGENTFS_SECRET_DECOY-unset}"` }))).toBe("unset\n");
    for (const command of [
      "curl https://example.invalid",
      "wget https://example.invalid",
      "node -e '1'",
      "python3 -c '1'",
      "js-exec '1'",
      "/bin/sh -c 'echo unsafe'",
      "bash -c 'echo unsafe'",
      "env",
      "printf '%999999999999s' x",
      `echo unsafe | tee /dev/tcp/127.0.0.1/1`,
    ]) {
      // /dev paths are virtual ordinary files; they never create sockets.
      if (command.includes("/dev/tcp")) await call("bash", { command });
      else await expect(call("bash", { command })).rejects.toThrow();
    }
    await expect(call("bash", { command: `sh -c 'echo unsafe > ${dir}/fallback'` })).rejects.toThrow();
    await expect(readFile(join(dir, "fallback"))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["%.101f", "%.101e", "%.101g", "%.0g"])(
    "keeps untrusted precision %s outside the restricted shell",
    async (format) => {
      const { call } = await fixture();
      expect(SHELL_COMMANDS).not.toContain("printf");
      expect(SHELL_COMMANDS).not.toContain("awk");
      for (const command of [`printf '${format}' 1`, `awk 'BEGIN { printf "${format}", 1 }'`]) {
        await expect(call("bash", { command })).rejects.toThrow(/command not found/);
      }
      expect(output(await call("bash", { command: "echo recovered" }))).toBe("recovered\n");
    },
  );
  it("bounds successful output, error output, source size, and infinite loops", async () => {
    const { call } = await fixture();
    await call("write", { path: "/lines", content: "line\n".repeat(4000) });
    for (const command of ["cat /lines", "head -c 80000 /large"]) {
      await call("write", { path: "/large", content: "x".repeat(80_000) });
      const result = await call("bash", { command });
      const text = output(result);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
      expect(text.split("\n").length).toBeLessThanOrEqual(2000);
      expect(text).toContain("truncated");
      expect(result.structuredContent).toMatchObject({ truncated: true });
      expect(JSON.stringify(result)).not.toContain("fullOutputPath");
    }
    await expect(call("bash", { command: "while true; do :; done" })).rejects.toThrow(/limit|iterations/i);
    await expect(call("bash", { command: "#".repeat(SHELL_LIMITS.maxSourceBytes + 1) })).rejects.toThrow(
      /limit|source|bytes/i,
    );
    await expect(call("bash", { command: "cat /lines; false" })).rejects.toSatisfy(
      (error: Error) => Buffer.byteLength(error.message) <= 50 * 1024 && error.message.split("\n").length <= 2000,
    );
    await expect(call("bash", { command: "seq 1 1000000" })).rejects.toThrow(/limit|output|bytes/i);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 31])("rejects timeout %s", async (timeout) => {
    const { call } = await fixture();
    await expect(call("bash", { command: "true", timeout })).rejects.toThrow(/Timeout/);
  });
  it("stops timed-out commands before later writes and keeps the queue usable", async () => {
    const { call } = await fixture();
    await expect(call("bash", { command: "sleep 5; echo bad > /late", timeout: 0.01 })).rejects.toThrow(/timed out/);
    await expect(call("read", { path: "/late" })).rejects.toThrow();
    expect(output(await call("bash", { command: "echo recovered" }))).toBe("recovered\n");
  });
  it("honors cancellation before execution and during a shell statement sequence", async () => {
    const { call, path } = await fixture();
    const pre = new AbortController();
    pre.abort();
    await expect(call("write", { path: "/early", content: "bad" }, pre.signal)).rejects.toThrow(/aborted/);
    const entered = deferred();
    const active = new AbortController();
    // A database-observable handshake proves the command has started before cancellation.
    const observer = await AgentFS.open({ path });
    try {
      const original = observer.fs.readFile.bind(observer.fs);
      const pending = call("bash", { command: "echo started > /ready; sleep 5; echo bad > /late" }, active.signal);
      const poll = async () => {
        for (let i = 0; i < 500; i++) {
          try {
            if (await original("/ready", "utf8")) {
              entered.resolve();
              return;
            }
          } catch {}
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error("Command did not reach readiness");
      };
      await poll();
      await entered.promise;
      active.abort();
      await expect(pending).rejects.toThrow(/aborted/i);
      await expect(call("read", { path: "/late" })).rejects.toThrow();
    } finally {
      await observer.close();
    }
  });
  it("drains an in-flight database write before cancellation releases the queue or shutdown closes it", async () => {
    const entered = deferred();
    const release = deferred();
    const initialize = Filesystem.fromDatabase.bind(Filesystem);
    let databaseClosed = false;
    vi.spyOn(Filesystem, "fromDatabase").mockImplementation(async (db, buffer) => {
      const filesystem = await initialize(db, buffer);
      const close = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(async () => {
        databaseClosed = true;
        await close();
      });
      const write = filesystem.writeFile.bind(filesystem);
      vi.spyOn(filesystem, "writeFile").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        expect(databaseClosed).toBe(false);
        await write(...args);
      });
      return filesystem;
    });
    const { workspace, call } = await fixture();
    const operation = call("write", { path: "/during", content: "completed before close" });
    const rejected = expect(operation).rejects.toThrow(/aborted/i);
    await entered.promise;
    const closing = workspace.close();
    expect(databaseClosed).toBe(false);
    release.resolve();
    await Promise.all([closing, rejected]);
    expect(databaseClosed).toBe(true);
  });
  it("closes partial schema initialization once after failure without opening unrelated SDK stores", async () => {
    const initialize = Filesystem.fromDatabase.bind(Filesystem);
    let closeCalls = 0;
    vi.spyOn(Filesystem, "fromDatabase").mockImplementation(async (db, buffer) => {
      const close = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(async () => {
        closeCalls++;
        await close();
      });
      vi.spyOn(db, "exec").mockRejectedValueOnce(new Error("schema failure"));
      return initialize(db, buffer);
    });
    const dir = await mkdtemp(join(tmpdir(), "pi-agentfs-failed-"));
    roots.push(dir);
    const workspace = new Workspace(join(dir, "a.db"));
    workspaces.push(workspace);
    await expect(workspace.open()).rejects.toThrow(/initialization failed/);
    await workspace.close();
    await workspace.close();
    expect(closeCalls).toBe(1);
    await expect(workspace.run(undefined, async (fs) => fs.readFile("/x"))).rejects.toThrow(/closed|not ready/);
  });
  it("waits for an initializing filesystem before closing a superseded workspace", async () => {
    const entered = deferred();
    const release = deferred();
    const initialize = Filesystem.fromDatabase.bind(Filesystem);
    let databaseClosed = false;
    vi.spyOn(Filesystem, "fromDatabase").mockImplementation(async (db, buffer) => {
      const close = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(async () => {
        databaseClosed = true;
        await close();
      });
      entered.resolve();
      await release.promise;
      expect(databaseClosed).toBe(false);
      return initialize(db, buffer);
    });
    const dir = await mkdtemp(join(tmpdir(), "pi-agentfs-open-"));
    roots.push(dir);
    const workspace = new Workspace(join(dir, "a.db"));
    workspaces.push(workspace);
    const opening = workspace.open();
    const rejected = expect(opening).rejects.toThrow(/initialization failed/);
    await entered.promise;
    const closing = workspace.close();
    expect(databaseClosed).toBe(false);
    release.resolve();
    await Promise.all([closing, rejected]);
    expect(databaseClosed).toBe(true);
  });
  it("shutdown stops a running shell before its next mutation", async () => {
    const { workspace, call, path } = await fixture();
    const observer = await AgentFS.open({ path });
    try {
      const shell = call("bash", { command: "echo ready > /started; sleep 5; echo bad > /after" });
      const rejected = expect(shell).rejects.toThrow(/aborted/i);
      let ready = false;
      for (let i = 0; i < 500 && !ready; i++) {
        try {
          ready = (await observer.fs.readFile("/started", "utf8")) === "ready\n";
        } catch {}
        if (!ready) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(ready).toBe(true);
      await Promise.all([workspace.close(), rejected]);
      await expect(observer.fs.readFile("/after")).rejects.toThrow();
    } finally {
      await observer.close();
    }
  });
  it("shutdown aborts active work, rejects queued writes, and is repeatable", async () => {
    const { workspace, call } = await fixture();
    const entered = deferred();
    const running = workspace.run(undefined, async (_fs, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const runningRejected = expect(running).rejects.toThrow(/aborted/i);
    await entered.promise;
    const queued = call("write", { path: "/queued", content: "bad" });
    const queuedRejected = expect(queued).rejects.toThrow(/closed|not ready/i);
    await Promise.all([workspace.close(), workspace.close(), runningRejected, queuedRejected]);
    await expect(call("read", { path: "/queued" })).rejects.toThrow(/closed|not ready/);
  });
});
