import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { registerSyncBackendContractSuite } from "./backend-contract-suite.js";
import { MockWebDavServer, webDavConfig } from "./mock-webdav-server.js";

for (const storagePath of ["pi-sync", "./"]) {
  registerSyncBackendContractSuite(`webdav (${storagePath})`, async () => {
    const server = await new MockWebDavServer().start();
    const config = webDavConfig(server.url);
    config.destination.path = storagePath;
    return {
      backend: new WebDavSyncBackend(config),
      dispose: () => server.close(),
    };
  });
}
