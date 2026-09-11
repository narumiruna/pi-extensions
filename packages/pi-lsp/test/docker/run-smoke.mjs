import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const smokeRoot = "/smoke/pi-lsp/test/docker";
const matrix = JSON.parse(readFileSync(path.join(smokeRoot, "matrix.json"), "utf8"));
const profileName = process.env.PROFILE;
const profile = matrix.profiles.find(({ name }) => name === profileName);
if (!profile) throw new Error(`Unknown or missing PROFILE: ${profileName ?? ""}`);

const piVersion = execFileSync("/smoke/node_modules/.bin/pi", ["--version"], {
  encoding: "utf8",
}).trim();
const versionResult = profile.versionCommand
  ? spawnSync(profile.versionCommand[0], profile.versionCommand.slice(1), {
      encoding: "utf8",
      timeout: 10_000,
    })
  : { status: 0, stdout: profile.packageVersion, stderr: "" };
const serverVersion = `${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`.trim();
const result = {
  profile: profile.name,
  piVersion,
  serverVersion,
  versionExitCode: versionResult.status,
  runs: [],
};

for (const caseName of ["error", "clean"]) {
  for (let repeat = 1; repeat <= (profile.repeats ?? matrix.repeats); repeat += 1) {
    result.runs.push(await runCase(caseName, repeat));
  }
}

result.passed = result.versionExitCode === 0 && result.runs.every(({ passed }) => passed === true);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;

async function runCase(caseName, repeat) {
  const fixture = profile.cases[caseName];
  const runRoot = mkdtempSync(path.join(os.tmpdir(), `pi-lsp-${profile.name}-${caseName}-`));
  const projectRoot = path.join(runRoot, "project");
  const agentDir = path.join(runRoot, "agent");
  const tracePath = path.join(runRoot, "trace.jsonl");
  mkdirSync(projectRoot);
  mkdirSync(agentDir);
  for (const [relativePath, content] of Object.entries(fixture.files)) {
    const target = path.join(projectRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const preparation = profile.prepareCommand
    ? spawnSync(profile.prepareCommand[0], profile.prepareCommand.slice(1), {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: profile.prepareTimeoutMs ?? 60_000,
      })
    : undefined;
  const preparationFailure =
    preparation && preparation.status !== 0
      ? `Fixture preparation failed (${preparation.status ?? preparation.signal ?? "unknown"}): ${`${preparation.stdout ?? ""}${preparation.stderr ?? ""}`.trim()}`
      : undefined;

  const serverConfig = {
    command: ["node", path.join(smokeRoot, "lsp-trace-proxy.mjs"), tracePath, "--", ...profile.command],
    extensions: profile.extensions,
    ...(profile.env ? { env: profile.env } : {}),
    ...(profile.initialization ? { initialization: profile.initialization } : {}),
    ...profile.policy,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    path.join(agentDir, "pi-lsp.json"),
    JSON.stringify({
      timeout: profile.timeoutMs ?? matrix.timeoutMs,
      servers: { [profile.name]: serverConfig },
    }),
  );
  process.env.PI_OFFLINE = "1";

  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir,
    settingsManager,
    additionalExtensionPaths: ["/smoke/pi-lsp/src/index.ts"],
    noExtensions: true,
  });
  const startedAt = performance.now();
  let output;
  let failure;
  let extensionErrors = [];
  let session;
  try {
    if (preparationFailure) throw new Error(preparationFailure);
    await loader.reload();
    const created = await createAgentSession({
      cwd: projectRoot,
      agentDir,
      noTools: "builtin",
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(projectRoot),
    });
    session = created.session;
    extensionErrors = created.extensionsResult.errors;
    if (extensionErrors.length > 0) {
      throw new Error(`Extension load failed: ${JSON.stringify(extensionErrors)}`);
    }
    const tool = session.agent.state.tools.find(({ name }) => name === "lsp_diagnostics");
    if (!tool) throw new Error("Pi did not register lsp_diagnostics");
    const toolResult = await tool.execute(
      `${profile.name}-${caseName}-${repeat}`,
      { root: projectRoot, paths: [fixture.path], server: profile.name },
      undefined,
      undefined,
    );
    output = toolResult.content?.find(({ type }) => type === "text")?.text ?? "";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await session?.dispose();
  }
  const durationMs = performance.now() - startedAt;
  const trace = summarizeTrace(tracePath);
  const diagnosticCount = parseDiagnosticCount(output);
  const passed =
    !failure &&
    (caseName === "clean"
      ? diagnosticCount === 0
      : diagnosticCount > 0 && new RegExp(fixture.expected, "iu").test(output));
  const run = {
    case: caseName,
    repeat,
    passed,
    durationMs,
    diagnosticCount,
    trace,
    ...(failure ? { failure } : {}),
    ...(passed ? {} : { output }),
    ...(extensionErrors.length > 0 ? { extensionErrors } : {}),
  };
  rmSync(runRoot, { recursive: true, force: true });
  return run;
}

function parseDiagnosticCount(output) {
  const match = /LSP diagnostics: (\d+) diagnostic\(s\)/u.exec(output ?? "");
  return match ? Number(match[1]) : -1;
}

function summarizeTrace(tracePath) {
  let events = [];
  try {
    events = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return { eventCount: 0, parseErrors: ["trace unavailable"] };
  }
  const requests = new Map();
  let didOpenAtMs;
  let diagnosticProvider = false;
  const pulls = [];
  const pushes = [];
  const refreshes = [];
  const progress = [];
  const parseErrors = [];
  for (const event of events) {
    const message = event.message;
    if (event.parseError) parseErrors.push(event.parseError);
    if (!message) continue;
    if (event.direction === "client-to-server" && message.method && message.id !== undefined) {
      requests.set(message.id, { method: message.method, atMs: event.atMs });
    }
    if (event.direction === "client-to-server" && message.method === "textDocument/didOpen") {
      didOpenAtMs = event.atMs;
    }
    if (event.direction === "server-to-client" && message.id !== undefined && !message.method) {
      const request = requests.get(message.id);
      if (request?.method === "initialize") {
        diagnosticProvider = Boolean(message.result?.capabilities?.diagnosticProvider);
      }
      if (request?.method === "textDocument/diagnostic") {
        pulls.push({
          requestAtMs: request.atMs,
          responseAtMs: event.atMs,
          items: message.result?.items?.length ?? null,
          error: message.error?.message,
        });
      }
    }
    if (event.direction === "server-to-client" && message.method === "textDocument/publishDiagnostics") {
      pushes.push({ atMs: event.atMs, items: message.params?.diagnostics?.length ?? 0 });
    }
    if (event.direction === "server-to-client" && message.method === "workspace/diagnostic/refresh") {
      refreshes.push({ atMs: event.atMs });
    }
    if (message.method === "$/progress") {
      progress.push({ atMs: event.atMs, kind: message.params?.value?.kind ?? "report" });
    }
  }
  return {
    eventCount: events.length,
    diagnosticProvider,
    didOpenAtMs,
    pulls,
    pushes,
    refreshes,
    progress,
    parseErrors,
  };
}
