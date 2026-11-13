import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("SIGKILL stops an actual child inside a synchronous native call, then releases the slot", async () => {
  const { fork } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "illustrate-native-cancel-"));
  const entry = join(root, "busy.mjs");
  await writeFile(
    entry,
    `import {pbkdf2Sync} from 'node:crypto';
    process.once('message',()=>{process.send({type:'busy'});pbkdf2Sync('input','salt',100000000,32,'sha512');});
    process.send({type:'ready'});`,
  );
  const abort = new AbortController();
  let child: import("node:child_process").ChildProcess | undefined;
  let renderer: import("../src/rasterizer.js").Rasterizer | undefined;
  let busy = false;
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    fork: (_url: URL, args: string[], options: import("node:child_process").ForkOptions) => {
      child = fork(entry, args, options);
      // Observe the child readiness boundary before the service listener. No production test hook is needed.
      child.on("message", (message) => {
        if ((message as { type?: string }).type === "busy") {
          busy = true;
          abort.abort();
        }
      });
      return child;
    },
  }));
  try {
    const { Rasterizer } = await import("../src/rasterizer.js");
    renderer = new Rasterizer();
    await expect(renderer.layout("svg", '<svg width="1" height="1"/>', abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(busy).toBe(true);
    expect(child?.signalCode).toBe("SIGKILL");
    expect(child?.exitCode).toBeNull();
    expect(renderer.active).toBe(0);
    const pid = child?.pid;
    expect(pid).toBeTypeOf("number");
    expect(() => process.kill(pid as number, 0)).toThrow();
  } finally {
    child?.kill("SIGKILL");
    await renderer?.dispose();
    vi.doUnmock("node:child_process");
    await rm(root, { recursive: true, force: true });
  }
});
