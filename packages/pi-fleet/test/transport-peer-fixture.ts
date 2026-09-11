import { createInterface } from "node:readline";
import { FLEET_PROTOCOL_VERSION, type FleetMessage, parseInvite } from "../src/protocol.js";
import { FleetTransport } from "../src/transport.js";

const [baseDirectory, invite, sessionId] = process.argv.slice(2);
if (!baseDirectory || !invite || !sessionId) throw new Error("fixture arguments are required");
let messageCount = 0;
const transport = new FleetTransport({
  group: parseInvite(invite),
  peer: {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    sessionId,
    name: sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    acceptsRequests: true,
  },
  baseDirectory,
  onMessage: async (message) => {
    messageCount += 1;
    write({ type: "message", message });
  },
});

await transport.start();
write({ type: "ready", sessionId });

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
  if (!line) continue;
  let command: Record<string, unknown>;
  try {
    command = JSON.parse(line) as Record<string, unknown>;
  } catch {
    continue;
  }
  const id = typeof command.id === "string" ? command.id : "unknown";
  try {
    if (command.type === "list") {
      write({ type: "response", id, ok: true, data: await transport.listPeers() });
      continue;
    }
    if (command.type === "count") {
      write({ type: "response", id, ok: true, data: messageCount });
      continue;
    }
    if (command.type === "send") {
      const targetSessionId = String(command.targetSessionId ?? "");
      const message = command.message as FleetMessage;
      write({
        type: "response",
        id,
        ok: true,
        data: await transport.send(targetSessionId, message),
      });
      continue;
    }
    if (command.type === "stop") {
      await transport.stop();
      write({ type: "response", id, ok: true });
      process.exitCode = 0;
      break;
    }
    throw new Error("unknown fixture command");
  } catch (error) {
    write({
      type: "response",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await transport.stop();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
