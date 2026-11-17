import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { watchContinuous } from "@narumitw/pi-sync-daemon/engine/sync/continuous-watch";
import { test, vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const native = vi.hoisted(() => ({
  fail: false,
  watchers: [] as {
    root: string;
    recursive: boolean;
    change(event: string, file: string | null): void;
    error?: () => void;
    closed: boolean;
  }[],
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: (root: string, options: { recursive: boolean }, change: (event: string, file: string | null) => void) => {
    if (native.fail) throw new Error("watch unavailable");
    const item = {
      root,
      recursive: options.recursive,
      change,
      error: undefined as (() => void) | undefined,
      closed: false,
    };
    native.watchers.push(item);
    return {
      on: (_event: string, error: () => void) => {
        item.error = error;
      },
      close: () => {
        item.closed = true;
      },
    };
  },
}));

test("watch hints follow selected roots, survive replacement, and exclude private state and symlinks", async () =>
  withTempHome(async (agentDir) => {
    native.watchers.length = 0;
    native.fail = false;
    await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
    const outside = path.join(agentDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(agentDir, "skills"));
    await fs.writeFile(
      localConfigPath(),
      JSON.stringify(v3S3Settings({ include: ["AGENTS.md", "prompts", "skills"] })),
    );
    const hints: boolean[] = [];
    const close = await watchContinuous(await loadConfig(), (settings) => hints.push(settings));
    try {
      assert.equal(native.watchers.length, 2);
      const root = native.watchers.find((item) => item.root === agentDir);
      assert.ok(root);
      root.change("rename", "AGENTS.md");
      root.change("rename", "pi-sync.json");
      root.change("change", "pi-sync/cache.json");
      root.change("change", ".pisync/state.json");
      root.change("change", "../auth.json");
      root.change("change", null);
      native.watchers.find((item) => item.root.endsWith("prompts"))?.change("change", "node_modules/cache.js");
      native.watchers.find((item) => item.root.endsWith("prompts"))?.change("change", "guide.md");
      assert.deepEqual(hints, [false, true, false]);
      root.error?.();
      assert.equal(root.closed, true);
    } finally {
      close();
      close();
    }
    assert.ok(native.watchers.every((item) => item.closed));
  }));

test("excluded content produces no hints, but ancestor and settings changes still do", async () =>
  withTempHome(async (agentDir) => {
    native.watchers.length = 0;
    native.fail = false;
    await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
    const settings = v3S3Settings({ include: ["skills"] });
    settings.version = 6;
    Object.assign(settings.syncSetups.home.sync, { exclude: ["skills/private", "**/*.log"] });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const hints: boolean[] = [];
    const close = await watchContinuous(await loadConfig(), (settings) => hints.push(settings));
    try {
      const root = native.watchers.find((item) => item.root === agentDir);
      const skills = native.watchers.find((item) => item.root.endsWith("skills"));
      assert.ok(root);
      assert.ok(skills);
      skills.change("change", "private/a.md");
      skills.change("change", ".hidden.log");
      skills.change("change", "public.md");
      root.change("rename", "skills");
      root.change("change", "pi-sync.json");
      assert.deepEqual(hints, [false, false, true]);
    } finally {
      close();
    }
    assert.ok(native.watchers.every((item) => item.closed));
  }));

test("unsupported watching and missing roots leave periodic fallback available", async () =>
  withTempHome(async (agentDir) => {
    native.watchers.length = 0;
    native.fail = true;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["AGENTS.md", "prompts"] })));
    try {
      const close = await watchContinuous(await loadConfig(), () => {
        throw new Error("unexpected hint");
      });
      close();
      assert.equal(native.watchers.length, 0);
    } finally {
      native.fail = false;
    }
  }));
