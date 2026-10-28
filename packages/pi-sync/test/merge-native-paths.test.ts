import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";

for (const filePath of [
  "notes:2026.md",
  "prompts/CON.md",
  "prompts/file. ",
  "prompts/zero\u200bwidth.md",
  "prompts/bidi\u202e.md",
  "prompts/control\u001b.md",
  "prompts/control\u0085.md",
  "prompts/line\nbreak.md",
])
  for (const auto of [false, true])
    for (const change of ["none", "edit", "delete"])
      test.skipIf(process.platform === "win32")(
        `${auto ? "automatic" : "manual"} merge ${change} preserves POSIX ${JSON.stringify(filePath)}`,
        async () =>
          withTempHome(async (agentDir) => {
            await fs.mkdir(path.dirname(path.join(agentDir, filePath)), { recursive: true });
            const settings = v3S3Settings({ include: [filePath.includes("/") ? "prompts" : filePath] });
            Object.assign(settings.syncSetups.home.sync, { automaticTransfer: auto });
            await fs.writeFile(localConfigPath(), JSON.stringify(settings));
            await fs.writeFile(path.join(agentDir, filePath), "base");
            const backend = new MemorySyncBackend();
            const { ctx } = createMockContext({ mode: "rpc" });
            await push(ctx, mergeOptions, undefined, () => backend);
            const head = await backend.readHead();
            assert.ok(head);
            const current = await backend.readSnapshot(head.snapshotRef);
            assert.ok(current.files.some((item) => item.path === filePath));
            if (change !== "none")
              await backend.publishSnapshot(
                regenerateSnapshotIdentity({
                  ...current,
                  files:
                    change === "delete" ? [] : snapshot([{ path: filePath, content: Buffer.from("remote") }]).files,
                }),
                { kind: "revision", revision: head.revision },
              );
            assert.equal(await syncBoth(ctx, { ...mergeOptions, auto }, () => backend), "applied");
            if (change === "delete") await assert.rejects(fs.access(path.join(agentDir, filePath)), { code: "ENOENT" });
            else
              assert.equal(
                await fs.readFile(path.join(agentDir, filePath), "utf8"),
                change === "edit" ? "remote" : "base",
              );
          }),
      );
