import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  assertEditorTargetSafeForPlatform,
  type ExternalEditorProcess,
  editProjectFileInExternalEditor,
  resolveEditableProjectFile,
} from "../src/external-editor.js";

async function withTempProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-editor-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createTui(events: string[]) {
  return {
    stop() {
      events.push("stop");
    },
    start() {
      events.push("start");
    },
    requestRender(force?: boolean) {
      events.push(`render:${String(force)}`);
    },
  } as never;
}

function createProcess(
  onListen: (listeners: {
    close: (code: number | null) => void;
    error: (error: Error) => void;
    process: ExternalEditorProcess;
  }) => void,
): ExternalEditorProcess {
  const listeners: {
    close?: (code: number | null) => void;
    error?: (error: Error) => void;
  } = {};
  const child: ExternalEditorProcess = {
    killed: false,
    kill() {
      Object.defineProperty(child, "killed", { value: true, configurable: true });
      return true;
    },
    once(event, listener) {
      listeners[event] = listener as never;
      if (listeners.close && listeners.error) {
        onListen({ close: listeners.close, error: listeners.error, process: child });
      }
      return child;
    },
  };
  return child;
}

test("resolves only regular project files and rejects outside paths and symlinks", async () => {
  await withTempProject(async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "safe.ts"), "safe\n");
    await symlink(join(root, "src", "safe.ts"), join(root, "linked.ts"));
    assert.equal(await resolveEditableProjectFile(root, "src/safe.ts"), join(root, "src", "safe.ts"));
    await assert.rejects(resolveEditableProjectFile(root, "../outside.ts"), /outside the project/u);
    await assert.rejects(resolveEditableProjectFile(root, "linked.ts"), /symbolic link/u);
    await assert.rejects(resolveEditableProjectFile(root, "src"), /not a regular file/u);
  });
});

test("rejects Windows shell metacharacters in editor target paths", () => {
  assert.doesNotThrow(() => assertEditorTargetSafeForPlatform("C:\\project files\\safe.ts", "win32"));
  assert.throws(
    () => assertEditorTargetSafeForPlatform("C:\\project\\unsafe&calc.ts", "win32"),
    /unsafe for the Windows external-editor shell/u,
  );
  assert.doesNotThrow(() => assertEditorTargetSafeForPlatform("/project/valid&literal.ts", "linux"));
});

test("uses Pi settings, serializes the mutation, and restores the current TUI", async () => {
  await withTempProject(async (root) => {
    const target = join(root, "file.ts");
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(target, "before\n");
    await writeFile(join(agentDir, "settings.json"), '{"externalEditor":"code --wait"}\n');
    const events: string[] = [];
    let releaseQueue: (() => void) | undefined;
    let queueReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      queueReady = resolve;
    });
    const blocker = withFileMutationQueue(
      target,
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
          queueReady?.();
        }),
    );
    await ready;
    const editing = editProjectFileInExternalEditor({
      root,
      projectPath: "file.ts",
      tui: createTui(events),
      projectTrusted: false,
      agentDir,
      isCurrent: () => true,
      spawnProcess(command, args) {
        events.push(`spawn:${command}:${args.join("|")}`);
        return createProcess(({ close }) => queueMicrotask(() => close(0)));
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, []);
    releaseQueue?.();
    await Promise.all([blocker, editing]);
    assert.deepEqual(events, ["stop", `spawn:code:--wait|${target}`, "start", "render:true"]);
  });
});

test("restores the TUI after editor failure and reports the exit code", async () => {
  await withTempProject(async (root) => {
    await writeFile(join(root, "file.ts"), "before\n");
    const events: string[] = [];
    await assert.rejects(
      editProjectFileInExternalEditor({
        root,
        projectPath: "file.ts",
        tui: createTui(events),
        projectTrusted: false,
        command: "false",
        spawnProcess() {
          return createProcess(({ close }) => queueMicrotask(() => close(7)));
        },
      }),
      /exited with code 7/u,
    );
    assert.deepEqual(events, ["stop", "start", "render:true"]);
  });
});

test("cancellation terminates the editor and does not restart a stale TUI", async () => {
  await withTempProject(async (root) => {
    await writeFile(join(root, "file.ts"), "before\n");
    const events: string[] = [];
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let child: ExternalEditorProcess | undefined;
    const editing = editProjectFileInExternalEditor({
      root,
      projectPath: "file.ts",
      tui: createTui(events),
      projectTrusted: false,
      command: "editor",
      signal: controller.signal,
      isCurrent: () => false,
      spawnProcess() {
        child = createProcess(({ close, process }) => {
          const originalKill = process.kill.bind(process);
          process.kill = () => {
            const killed = originalKill();
            queueMicrotask(() => close(null));
            return killed;
          };
          started?.();
        });
        return child;
      },
    });
    await ready;
    controller.abort();
    await assert.rejects(editing, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });
    assert.equal(child?.killed, true);
    assert.deepEqual(events, ["stop"]);
  });
});
