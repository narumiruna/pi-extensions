import { type ConnectionOptions, DaemonConnection } from "../src/client.js";
import type { ClientFacts, Execute } from "../src/protocol.js";
import { type ServerHooks, startServer } from "../src/server.js";

export interface RpcFixture {
  server: Awaited<ReturnType<typeof startServer>>;
  createConnection(facts: ClientFacts, options: ConnectionOptions): DaemonConnection;
}

export async function withRpcServer<T>(
  root: string,
  execute: Execute,
  run: (fixture: RpcFixture) => Promise<T>,
  hooks?: ServerHooks,
) {
  await using resources = new AsyncDisposableStack();
  const server = await startServer(root, execute, hooks);
  resources.defer(() => server.close());
  return await run({
    server,
    createConnection(facts, options) {
      const connection = new DaemonConnection(server.paths, server.identity, facts, options);
      resources.defer(() => connection.dispose());
      return connection;
    },
  });
}
