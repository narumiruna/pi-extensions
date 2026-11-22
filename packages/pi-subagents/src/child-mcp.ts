import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionHandler,
  getAgentDir,
  type McpServerConfig,
  type McpServerEntry,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChildMcpSelection } from "./broker-credentials.js";

class McpSelectionError extends Error {}

export function installChildMcp(pi: ExtensionAPI, selection: ChildMcpSelection): () => string | undefined {
  let error: string | undefined;
  try {
    const cwd = process.cwd();
    const entries = selectServerConfigs(
      selection,
      join(getAgentDir(), "mcp.json"),
      join(cwd, CONFIG_DIR_NAME, "mcp.json"),
    );
    for (const entry of entries) {
      try {
        if (entry.base) pi.registerMcpServer(entry.name, entry.base as McpServerConfig);
        pi.registerMcpServer(entry.name, entry.config as McpServerConfig);
      } catch {
        throw new McpSelectionError(`Invalid or conflicting MCP server "${entry.name}".`);
      }
    }
    let servers: McpServerEntry[] = [];
    pi.on("session_start", (_event, ctx) => {
      servers = [];
      if (ctx.cwd !== cwd || ctx.isProjectTrusted() !== selection.projectTrusted) {
        error = "Subagent MCP project context changed during startup.";
        return;
      }
      const registered = new Map(pi.getMcpServers().map((entry) => [entry.name, entry.config]));
      const selected: McpServerEntry[] = [];
      for (const { name, source } of entries) {
        const config = registered.get(name);
        if (!config || config.enabled === false) {
          error = `MCP server "${name}" is unavailable or disabled.`;
          return;
        }
        selected.push({ name, source, config });
      }
      servers = selected;
    });
    createMcpExtension({
      loadConfig: (ctx) => ({
        servers: ctx.cwd === cwd && ctx.isProjectTrusted() === selection.projectTrusted ? servers : [],
        errors: [],
        autoEnableCodemode: false,
      }),
    })({
      ...pi,
      on: startMcpAtFirstPrompt(pi),
      getMcpServers: () => [],
      registerCommand: () => {},
    });
  } catch (cause) {
    error = cause instanceof McpSelectionError ? cause.message : "Subagent could not initialize Pi's MCP support.";
  }
  return () => error;
}

function startMcpAtFirstPrompt(pi: ExtensionAPI): ExtensionAPI["on"] {
  return (event: string, handler: unknown) => {
    if (event !== "session_start") return Reflect.apply(pi.on, pi, [event, handler]);
    const startSession = handler as ExtensionHandler<SessionStartEvent>;
    let pending: SessionStartEvent | undefined;
    const offStart = pi.on("session_start", (event) => {
      pending = event;
    });
    const offPrompt = pi.on("before_agent_start", (_event, ctx) => {
      const start = pending;
      pending = undefined;
      if (start && !ctx.signal?.aborted) return startSession(start, ctx);
    });
    return () => {
      pending = undefined;
      offStart();
      offPrompt();
    };
  };
}

interface ConfiguredServer {
  name: string;
  source: string;
  config: unknown;
  base?: unknown;
}

function selectServerConfigs(
  selection: ChildMcpSelection,
  globalPath: string,
  projectPath: string,
): ConfiguredServer[] {
  const user = readServers(globalPath, "user");
  const project = selection.projectTrusted ? readServers(projectPath, "project") : {};
  const names = new Set([...Object.keys(user), ...Object.keys(project)]);
  const namespaces = new Map<string, number>();
  for (const name of names) {
    const namespace = name.replaceAll("-", "_");
    namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
  }
  return selection.servers.map((name) => {
    const hasUser = Object.hasOwn(user, name);
    const hasProject = Object.hasOwn(project, name);
    if (!hasUser && !hasProject) throw new McpSelectionError(`MCP server "${name}" is not configured for this job.`);
    if ((namespaces.get(name.replaceAll("-", "_")) ?? 0) > 1) {
      throw new McpSelectionError(`MCP server "${name}" has a conflicting name in Pi's MCP configuration.`);
    }
    const base = hasUser ? user[name] : undefined;
    const override = hasProject ? project[name] : undefined;
    if (hasProject && !isRecord(override)) throw new McpSelectionError(`Invalid project MCP server "${name}".`);
    if (isRecord(override)) {
      if (override.command === undefined && override.url === undefined && override.type === undefined) {
        if (
          !isRecord(base) ||
          Object.keys(override).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))
        ) {
          throw new McpSelectionError(`Invalid project override for MCP server "${name}".`);
        }
        return { name, source: globalPath, base, config: { ...base, ...override } };
      }
      if (Object.hasOwn(override, "auth")) {
        throw new McpSelectionError(`Project MCP server "${name}" cannot use provider authentication.`);
      }
      return { name, source: projectPath, config: override };
    }
    return { name, source: globalPath, config: base };
  });
}

function readServers(path: string, scope: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
    if (isRecord(value)) {
      if (value.mcpServers === undefined) return {};
      if (isRecord(value.mcpServers)) return value.mcpServers;
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
  }
  throw new McpSelectionError(`Unable to read Pi's ${scope} MCP configuration.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
