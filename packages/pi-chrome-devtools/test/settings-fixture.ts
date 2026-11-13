import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";

export function useChromeSettingsFixture(prefix: string) {
  let root: string;
  let previousDir: string | undefined;
  beforeAll(async () => {
    await import("@earendil-works/pi-coding-agent");
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), prefix));
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    vi.resetModules();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      // Drain the runtime transaction, not merely its underlying file writes.
      await (await import("../src/tool-selector.js")).waitForChromeDevtoolsSettings();
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    get root() {
      return root;
    },
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
