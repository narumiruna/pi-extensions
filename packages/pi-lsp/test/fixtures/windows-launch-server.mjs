import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.PI_LSP_TEST_LAUNCH_RECORD,
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    value: process.env.PI_LSP_TEST_ENV,
    batchArguments: process.env.PI_LSP_TEST_BATCH_ARGUMENTS,
    pid: process.pid,
  }),
);
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString())[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString());
    buffer = buffer.subarray(start + length);
    if (message.method === "exit") process.exit(0);
    if (message.id === undefined) continue;
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: message.method === "initialize" ? { capabilities: {} } : null,
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
  }
});
process.stdin.on("end", () => process.exit(0));
