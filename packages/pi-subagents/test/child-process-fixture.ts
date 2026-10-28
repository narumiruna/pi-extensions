import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface FakePiOptions {
  bundled?: boolean;
  readiness?:
    | "success"
    | "manual"
    | "failure"
    | "malformed"
    | "missingSources"
    | "wrongCount"
    | "invalidFingerprint"
    | "oversized"
    | "close";
}

export function installFakePi(directory: string, source: string, options: FakePiOptions = {}): void {
  const packageDirectory = path.join(directory, "pi-core");
  const executableName = options.bundled ? "pi" : "fake-pi.mjs";
  const executablePath = path.join(packageDirectory, executableName);
  const readinessSetup = {
    success:
      'signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => sourceId(firstExtension)), model: selectedModel }) + "\\n");',
    manual: "",
    failure:
      'signalReadiness(JSON.stringify({ ok: false, error: "Requested extension tool is unavailable." }) + "\\n");',
    malformed: 'signalReadiness("not-json\\n");',
    missingSources: 'signalReadiness(JSON.stringify({ ok: true }) + "\\n");',
    wrongCount: 'signalReadiness(JSON.stringify({ ok: true, sources: [] }) + "\\n");',
    invalidFingerprint:
      'signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => "wrong") }) + "\\n");',
    oversized: 'signalReadiness("x".repeat(16 * 1024 + 1));',
    close: "closeReadiness();",
  }[options.readiness ?? "success"];
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    executablePath,
    `${options.bundled ? "#!/usr/bin/env node\n" : ""}import fs from "node:fs";
import { createHash } from "node:crypto";
const childBootstrap = JSON.parse(fs.readFileSync(3, "utf8"));
const brokerCredentials = childBootstrap.communication;
const expectedTools = childBootstrap.expectedTools;
const selection = childBootstrap.selection;
if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string" || selection.thinkingLevel !== process.argv[process.argv.indexOf("--thinking") + 1]) throw new Error("Invalid bootstrap selection");
if (process.argv.includes("--provider") || process.argv.includes("--model")) throw new Error("Target selection must not use CLI patterns");
const selectedModel = { provider: selection.provider, id: selection.model };
const sourceId = (value) => createHash("sha256").update(value).digest("hex");
const firstExtensionFlag = process.argv.indexOf("-e", process.argv.indexOf("-e") + 1);
const firstExtension = firstExtensionFlag < 0 ? "" : process.argv[firstExtensionFlag + 1];
const closeReadiness = () => fs.closeSync(4);
const signalReadiness = (frame) => {
  try {
    fs.writeFileSync(4, frame, "utf8");
  } finally {
    fs.closeSync(4);
  }
};
${readinessSetup}
const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error) => event({
  id: command.id,
  type: "response",
  command: command.type,
  success,
  ...(error ? { error } : {}),
  ...(command.type === "get_state" ? { data: { model: selectedModel } } : {}),
});
const message = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
${source}
const dispatch = async (command) => {
  if (command.type === "get_state") {
    if (globalThis.fakeStateHandler) await globalThis.fakeStateHandler(command);
    else if (Object.hasOwn(globalThis, "fakeState")) event({ id: command.id, type: "response", command: command.type, success: true, data: globalThis.fakeState });
    else respond(command);
    return;
  }
  if (command.type === "get_commands") {
    event({ id: command.id, type: "response", command: command.type, success: true, data: { commands: globalThis.fakeCommands ?? [] } });
    return;
  }
  await handle(command);
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void dispatch(JSON.parse(line));
  }
});
`,
  );
  if (options.bundled) chmodSync(executablePath, 0o755);
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: options.bundled ? "./dist/bundle/cli.js" : "./fake-pi.mjs" },
    }),
  );
  process.env.PI_PACKAGE_DIR = packageDirectory;
  if (options.bundled) {
    process.execPath = executablePath;
    process.versions.bun = "1.3.0";
  }
}
