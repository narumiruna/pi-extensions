import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { withTempHome } from "./helpers.js";

for (const phase of ["before", "root", "directory", "file"] as const) {
  test(`snapshot cancellation during ${phase} stops all later traversal`, async () => {
    await withTempHome(async (agentDir) => {
      const skills = path.join(agentDir, "skills");
      await fs.mkdir(skills, { recursive: true });
      await fs.writeFile(path.join(skills, "one.md"), "one");
      await fs.writeFile(path.join(skills, "two.md"), "two");
      const controller = new AbortController();
      const reason = new DOMException("cancel snapshot", "AbortError");
      const readdir = fs.readdir.bind(fs);
      const readFile = fs.readFile.bind(fs);
      let afterAbort = 0;
      let reads = 0;
      const directorySpy = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (controller.signal.aborted) afterAbort++;
        const result = await readdir(...args);
        if ((phase === "root" && String(args[0]) === agentDir) || (phase === "directory" && String(args[0]) === skills))
          controller.abort(reason);
        return result;
      });
      const fileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (controller.signal.aborted) afterAbort++;
        reads++;
        if (phase === "file") {
          assert.equal((args[1] as { signal?: AbortSignal }).signal, controller.signal);
          controller.abort(reason);
        }
        return readFile(...args);
      });
      try {
        if (phase === "before") controller.abort(reason);
        await assert.rejects(
          createSnapshot("home", {
            include: ["skills"],
            sessionDir: path.join(agentDir, "sessions"),
            signal: controller.signal,
          }),
          /cancel snapshot|aborted/iu,
        );
        assert.equal(afterAbort, 0);
        assert.equal(reads, phase === "file" ? 1 : 0);
      } finally {
        directorySpy.mockRestore();
        fileSpy.mockRestore();
      }
    });
  });
}
