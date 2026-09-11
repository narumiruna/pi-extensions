import { rmSync } from "node:fs";
import path from "node:path";
import { GitSyncBackend } from "../src/backends/git/git-backend.js";
import { registerSyncBackendContractSuite } from "./backend-contract-suite.js";
import { createBareRemote, gitConfig } from "./git-test-helpers.js";

for (const directory of ["pi-sync", "./"]) {
  registerSyncBackendContractSuite(`git (${directory})`, () => {
    const fixture = createBareRemote();
    const config = gitConfig(fixture.remote);
    config.destination.directory = directory;
    config.destination.branch = "main";
    return {
      backend: new GitSyncBackend(config, {
        cacheRoot: path.join(fixture.root, "cache"),
        allowLocalRemotes: true,
      }),
      dispose: () => rmSync(fixture.root, { recursive: true, force: true }),
    };
  });
}
