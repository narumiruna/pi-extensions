import "./local-network.mjs";
import fs from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createEngineService } from "../../dist/engine-service.js";
import { startServer } from "../../dist/server.js";

const root = process.argv[2];
process.chdir(root);
const engine = createEngineService(root);
const wire = [];
const releases = new Map();
let dropRelease;
let installs = 0;
const rename = fs.rename;
const applyTarget = path.join(root, "AGENTS.md");
fs.rename = async (from, to) => {
  await rename(from, to);
  if (to === applyTarget) installs++;
};
let holdPolls = false;
const heldPolls = new Set();
const createServer = http.createServer;
// Observe the real HTTP endpoint without bypassing its identity checks. Buffer the
// test-owned request so a pre-accept drop never reaches the daemon's listener.
http.createServer = (listener) =>
  createServer(async (request, response) => {
    const chunks = [];
    let envelope;
    try {
      for await (const chunk of request) chunks.push(chunk);
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.destroy();
      return;
    }
    const { method, params } = envelope;
    const record = {
      method,
      id: params?.id,
      operation: params?.operation,
      facts: method === "attach" || method === "resume-contact" ? params : params?.facts,
    };
    const release = method === "answer" ? releases.get(params.id) : undefined;
    if (release) {
      record.release = {
        job: release.job,
        reservation: release.payload.reservation,
        client: params.client,
        value: params.value,
        error: params.error,
        accepted: false,
      };
    }
    wire.push(record);
    if (release && dropRelease === "before-accept") {
      record.release.dropped = dropRelease;
      dropRelease = undefined;
      response.destroy();
      return;
    }
    request[Symbol.asyncIterator] = async function* () {
      yield* chunks;
    };
    const end = response.end;
    response.end = function (body, ...args) {
      const { result, error } = JSON.parse(body);
      if (record.release) {
        record.release.accepted = this.statusCode === 200 && !error;
        if (record.release.accepted && dropRelease === "after-accept") {
          record.release.dropped = dropRelease;
          dropRelease = undefined;
          response.destroy();
          return this;
        }
      }
      const send = () => {
        if (response.destroyed) return;
        const job = result?.job;
        Object.assign(record, {
          contact: result?.contact,
          job: job && { id: job.id, phase: job.phase, error: job.error, result: job.result },
          error,
        });
        for (const callback of result?.callbacks ?? [])
          if (callback.kind === "queue-release") releases.set(callback.id, callback);
        end.call(this, body, ...args);
      };
      // Hold background observations only, so foreground preflight can see expiry first.
      if (holdPolls && (method === "state-wait" || (method === "poll" && params.job === undefined))) {
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

async function perform(command, option) {
  switch (command) {
    case "expire": {
      holdPolls = option;
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
    case "drop-queue-release":
      if (dropRelease || !["before-accept", "after-accept"].includes(option))
        throw new Error("Invalid or overlapping queue-release fault.");
      dropRelease = option;
      return;
    case "inspect":
      return wire;
    case "installs":
      return installs;
    case "stop":
      releasePolls();
      // The fixture has joined its Pi children. Retire exited clients before
      // stopping the heartbeat, including when a regression leaves a release pending.
      await server.expireClients();
      await server.close();
      return;
    default:
      throw new Error(`Unknown fixture control: ${command}`);
  }
}

process.on("message", ({ id, command, option }) => {
  void perform(command, option).then(
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
