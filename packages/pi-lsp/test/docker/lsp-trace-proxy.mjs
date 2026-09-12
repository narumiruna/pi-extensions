import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";

const separator = process.argv.indexOf("--");
const tracePath = process.argv[2];
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
if (!tracePath || separator !== 3 || !command) {
  throw new Error("Usage: lsp-trace-proxy.mjs <trace-path> -- <command> [args...]");
}

const startedAt = performance.now();
const trace = createWriteStream(tracePath, { flags: "a" });
const child = spawn(command, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

const clientParser = createParser("client-to-server");
const serverParser = createParser("server-to-client");
process.stdin.on("data", (chunk) => {
  clientParser(chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", (chunk) => {
  serverParser(chunk);
  process.stdout.write(chunk);
});
child.stderr.pipe(process.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  record({ direction: "process", error: error.message });
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  record({ direction: "process", code, signal });
  trace.end(() => process.exit(code ?? (signal ? 1 : 0)));
});

function createParser(direction) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!contentLength) {
        record({ direction, parseError: `Missing Content-Length: ${header}` });
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(contentLength);
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      buffer = buffer.subarray(bodyStart + bodyLength);
      try {
        record({ direction, message: JSON.parse(body) });
      } catch (error) {
        record({
          direction,
          parseError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

function record(event) {
  trace.write(`${JSON.stringify({ atMs: performance.now() - startedAt, ...event })}\n`);
}
