import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [log, behavior] = process.argv.slice(2);
const record = (message) => appendFileSync(log, `${message}\n`);
record("start");
if (behavior === "wait-for-term") setInterval(() => {}, 60_000);
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => record("stop"));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const schema = { type: "object", properties: {} };
  let result;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "subagent-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = { tools: ["direct", "indirect", "hidden"].map((name) => ({ name, inputSchema: schema })) };
      break;
    case "tools/call":
      record(params.name);
      result = { content: [{ type: "text", text: `fixture:${params.name}` }] };
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
