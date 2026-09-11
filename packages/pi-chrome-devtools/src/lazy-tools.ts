import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { webMcpEnabled } from "./runtime.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName, isWebMcpToolName } from "./tool-names.js";

export const CHROME_DEVTOOLS_LOAD_TOOL_NAME = "chrome_devtools_load";

const AVAILABLE_TOOLS_STORE = Symbol.for("@narumitw/pi-chrome-devtools.available-tools-store");
type ChromeDevtoolsGlobal = typeof globalThis & {
  [AVAILABLE_TOOLS_STORE]?: WeakMap<ExtensionAPI, Set<ChromeDevToolsToolName>>;
};
const sharedGlobal = globalThis as ChromeDevtoolsGlobal;
const existingAvailableToolsStore = sharedGlobal[AVAILABLE_TOOLS_STORE];
const availableToolsByApi = existingAvailableToolsStore ?? new WeakMap<ExtensionAPI, Set<ChromeDevToolsToolName>>();
if (!existingAvailableToolsStore) sharedGlobal[AVAILABLE_TOOLS_STORE] = availableToolsByApi;
const lazyExposureByApi = new WeakMap<ExtensionAPI, boolean>();
const sessionOwnerByApi = new WeakMap<ExtensionAPI, object>();

const SEARCH_TEXT: Record<ChromeDevToolsToolName, string> = {
  chrome_devtools_list_pages: "list open inspectable chrome browser pages tabs targets",
  chrome_devtools_select_page: "select choose active chrome browser page tab target",
  chrome_devtools_navigate: "navigate open create chrome browser page url website",
  chrome_devtools_evaluate: "evaluate run javascript expression dom inspect chrome browser page",
  chrome_devtools_screenshot: "capture screenshot png image visual chrome browser page",
  chrome_devtools_webmcp_list_tools: "list discover page provided website webmcp tools capabilities experimental",
  chrome_devtools_webmcp_call_tool: "call invoke page provided website webmcp tool confirmation experimental",
};

export function setChromeDevtoolsSessionOwner(pi: ExtensionAPI, owner: object) {
  sessionOwnerByApi.set(pi, owner);
}

export function initializeAvailableChromeDevtoolsTools(pi: ExtensionAPI) {
  if (availableToolsByApi.has(pi)) return;
  const activeTools = new Set(pi.getActiveTools());
  setAvailableTools(
    pi,
    CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => activeTools.has(name)),
  );
}

export function configureChromeDevtoolsToolExposure(
  pi: ExtensionAPI,
  availableTools: readonly ChromeDevToolsToolName[],
  model?: ExtensionContext["model"],
) {
  setAvailableTools(pi, availableTools);
  const available = effectiveAvailableTools(pi);
  const lazyExposure = supportsNativeDeferredToolLoading(model);
  lazyExposureByApi.set(pi, lazyExposure);
  const exposedTools = lazyExposure ? [] : CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
  const nonCapabilityTools = pi
    .getActiveTools()
    .filter((name) => !CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName));
  pi.setActiveTools(unique([...nonCapabilityTools, CHROME_DEVTOOLS_LOAD_TOOL_NAME, ...exposedTools]));
}

export function requireEagerChromeDevtoolsToolExposure(pi: ExtensionAPI) {
  lazyExposureByApi.set(pi, false);
  const active = pi.getActiveTools();
  const available = availableChromeDevtoolsTools(pi);
  pi.setActiveTools(unique([...active, CHROME_DEVTOOLS_LOAD_TOOL_NAME, ...available]));
}

export function applyAvailableChromeDevtoolsTools(pi: ExtensionAPI, availableTools: readonly ChromeDevToolsToolName[]) {
  setAvailableTools(pi, availableTools);
  const available = effectiveAvailableTools(pi);
  const lazyExposure = lazyExposureByApi.get(pi) === true;
  const active = pi
    .getActiveTools()
    .filter(
      (name) =>
        !CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName) ||
        (lazyExposure && available.has(name as ChromeDevToolsToolName)),
    );
  const eagerTools = lazyExposure ? [] : CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
  pi.setActiveTools(unique([...active, CHROME_DEVTOOLS_LOAD_TOOL_NAME, ...eagerTools]));
}

export function chromeDevtoolsToolExposureMode(pi: ExtensionAPI) {
  return lazyExposureByApi.get(pi) === true ? "native deferred" : "eager";
}

export function supportsNativeDeferredToolLoading(model: ExtensionContext["model"]): boolean {
  if (!model) return false;
  if (model.api === "anthropic-messages") {
    const configured = compatBoolean(model.compat, "supportsToolReferences");
    if (configured !== undefined) return configured;
    if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
    const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
    if (!version) return false;
    const major = Number(version[1]);
    const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
    return major > 4 || (major === 4 && minor >= 5);
  }
  if (model.api === "openai-completions") {
    return compatString(model.compat, "deferredToolsMode") === "kimi";
  }
  if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
    return (
      compatBoolean(model.compat, "supportsAdditionalTools") === true ||
      compatBoolean(model.compat, "supportsToolSearch") === true
    );
  }
  return false;
}

export function availableChromeDevtoolsTools(pi: ExtensionAPI) {
  const available = effectiveAvailableTools(pi);
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
}

export function configuredChromeDevtoolsTools(pi: ExtensionAPI) {
  const available = availableToolsByApi.get(pi) ?? new Set();
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
}

export function createChromeDevtoolsLoadTool(pi: ExtensionAPI) {
  return defineTool({
    name: CHROME_DEVTOOLS_LOAD_TOOL_NAME,
    label: "Chrome DevTools: Load Tools",
    description:
      "Find and enable Chrome DevTools browser tools relevant to a task. Loaded tools remain available for the session.",
    promptSnippet: "Load Chrome DevTools browser capabilities on demand",
    promptGuidelines: [
      "Use chrome_devtools_load when a task requires inspecting or controlling a Chrome browser and the needed chrome_devtools_* capability is not active.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Browser capability or task to find tools for.",
        maxLength: 500,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum tools to load. Defaults to 3.",
          minimum: 1,
          maximum: 5,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      setChromeDevtoolsSessionOwner(pi, ctx.sessionManager);
      const available = new Set(availableChromeDevtoolsTools(pi));
      const matches = matchChromeDevtoolsTools(params.query, params.limit ?? 3, available);
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const added = matches.filter((name) => !activeSet.has(name));
      if (added.length > 0) {
        pi.setActiveTools(unique([...active, ...added]));
      }

      const text =
        matches.length === 0
          ? "No available Chrome DevTools tools matched the query."
          : added.length > 0
            ? `Loaded Chrome DevTools tools: ${added.join(", ")}`
            : `Matching Chrome DevTools tools are already loaded: ${matches.join(", ")}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { matches, added },
      };
    },
  });
}

function matchChromeDevtoolsTools(query: string, limit: number, available: ReadonlySet<ChromeDevToolsToolName>) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return [];
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name))
    .map((name, index) => ({
      name,
      index,
      score: terms.reduce((score, term) => score + (SEARCH_TEXT[name].includes(term) ? 1 : 0), 0),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((match) => match.name);
}

function setAvailableTools(pi: ExtensionAPI, availableTools: readonly ChromeDevToolsToolName[]) {
  const available = new Set(availableTools);
  availableToolsByApi.set(pi, available);
  return available;
}

function effectiveAvailableTools(pi: ExtensionAPI) {
  const configured = availableToolsByApi.get(pi) ?? new Set();
  const owner = sessionOwnerByApi.get(pi);
  const enabled = owner !== undefined && webMcpEnabled(owner);
  return new Set(
    CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => configured.has(name) && (enabled || !isWebMcpToolName(name))),
  );
}

function compatBoolean(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function compatString(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : undefined;
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
