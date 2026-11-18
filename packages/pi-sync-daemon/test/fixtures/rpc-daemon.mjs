import "./local-network.mjs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createEngineService } from "../../dist/engine-service.js";
import { startServer } from "../../dist/server.js";

const root = process.argv[2];
process.chdir(root);
const engine = createEngineService(root);
const wire = [];
let holdPolls = false;
const heldPolls = new Set();
const createServer = http.createServer;
// Observe the real authenticated HTTP endpoint. Hold idle poll replies only, so foreground
// preflight can see expiry before the background loop, without blocking cleanup or other IPC.
http.createServer = (listener) =>
  createServer((request, response) => {
    const chunks = [];
    let record;
    let jobPoll = false;
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      record = {
        method,
        id: params?.id,
        operation: params?.operation,
        facts: method === "attach" || method === "resume-contact" ? params : params?.facts,
      };
      jobPoll = params?.job !== undefined;
      wire.push(record);
    });
    const end = response.end;
    response.end = function (body, ...args) {
      const { result, error } = JSON.parse(body);
      const send = () => {
        if (response.destroyed) return;
        if (record) {
          const job = result?.job;
          Object.assign(record, {
            contact: result?.contact,
            job: job && { id: job.id, phase: job.phase, error: job.error },
            error,
          });
        }
        end.call(this, body, ...args);
      };
      if (holdPolls && record?.method === "poll" && !jobPoll) {
        heldPolls.add(send);
        response.once("close", () => heldPolls.delete(send));
      } else send();
      return this;
    };
    return listener(request, response);
  });
syncBuiltinESMExports();
const server = await startServer(root, engine.execute, engine.hooks).finally(() => {
  http.createServer = createServer;
  syncBuiltinESMExports();
});
engine.bind(server);

function releasePolls() {
  holdPolls = false;
  for (const reply of heldPolls) reply();
  heldPolls.clear();
}

async function perform(command, gate) {
  switch (command) {
    case "expire": {
      holdPolls = gate;
      await server.expireClients();
      const now = Date.now;
      Date.now = () => now() + 6_000;
      let sweep;
      try {
        // The heartbeat check runs synchronously before its first write. Do not advance
        // the rest of the service's clock while waiting for persistence or monitor work.
        sweep = server.expireClients();
      } finally {
        Date.now = now;
      }
      await sweep;
      return server.liveClients();
    }
    case "release":
      releasePolls();
      return;
    case "inspect":
      return wire;
    case "stop":
      releasePolls();
      await server.close();
      return;
    default:
      throw new Error(`Unknown fixture control: ${command}`);
  }
}

process.on("message", ({ id, command, gate }) => {
  void perform(command, gate).then(
    (data) =>
      process.send?.({ id, data }, () => {
        if (command === "stop" && process.connected) process.disconnect();
      }),
    (error) => process.send?.({ id, error: String(error) }),
  );
});
process.on("disconnect", () => {
  releasePolls();
  void server.close().catch(() => {
    process.exitCode = 1;
  });
});
process.send?.({ ready: true });
