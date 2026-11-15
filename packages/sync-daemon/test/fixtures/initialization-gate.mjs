import { createEngineService } from "../../dist/engine-service.js";
import { startServer } from "../../dist/server.js";

const root = process.argv[2];
let release;
const released = new Promise((resolve) => {
  release = resolve;
});
let gated = false;
process.on("message", (message) => {
  if (message?.type === "release") release();
});
const service = createEngineService(root);
const server = await startServer(
  root,
  async (operation, payload, execution) => {
    if (operation === "initialize" && !gated) {
      gated = true;
      process.send?.({ type: "initializing" });
      const abort = () => rejectAbort(execution.signal.reason);
      let rejectAbort;
      const aborted = new Promise((_, reject) => {
        rejectAbort = reject;
      });
      execution.signal.addEventListener("abort", abort, { once: true });
      try {
        execution.signal.throwIfAborted();
        await Promise.race([released, aborted]);
      } finally {
        execution.signal.removeEventListener("abort", abort);
      }
    }
    return service.execute(operation, payload, execution);
  },
  service.hooks,
);
service.bind(server);
process.on("disconnect", () => {
  release();
  void server.close().catch(() => {
    process.exitCode = 1;
  });
});
process.send?.({ type: "ready" });
process.channel?.unref();
