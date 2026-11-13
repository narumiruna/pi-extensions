import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeChromeDevtoolsDisplay } from "./display.js";
import { webMcpEnabled } from "./runtime.js";
import type { ChromeDevToolsToolMode } from "./settings.js";
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
// Public sessionManager identity survives factory/API rebuilds during /reload.
// A redundant host selection of an already-owned active name has no public
// provenance signal; keep known ownership rather than treating carryover as intent.
const PROVENANCE_STORE = Symbol.for("@narumitw/pi-chrome-devtools.activation-provenance");
const PROVENANCE_ENTRY = "chrome-devtools.activation-provenance";
type ActivationOwnership = {
  explicit: Set<string>;
  owned: Set<string>;
  available?: Set<ChromeDevToolsToolName>;
  mode?: ChromeDevToolsToolMode;
  published?: Set<ChromeDevToolsToolName>;
  serialized?: string;
};
const provenanceGlobal = globalThis as typeof globalThis & {
  [PROVENANCE_STORE]?: WeakMap<object, ActivationOwnership>;
};
const ownedBySession = provenanceGlobal[PROVENANCE_STORE] ?? new WeakMap<object, ActivationOwnership>();
provenanceGlobal[PROVENANCE_STORE] = ownedBySession;
const modeByApi = new WeakMap<ExtensionAPI, ChromeDevToolsToolMode>();
const loaderRegistered = new WeakSet<ExtensionAPI>();

function retainedExplicitTools(pi: ExtensionAPI, before: readonly string[]) {
  const owner = sessionOwnerByApi.get(pi);
  const ownership = owner ? ownedBySession.get(owner) : undefined;
  const observed = new Set(before);
  // Only our own last publication can prove suppression rather than withdrawal.
  return CHROME_DEVTOOLS_TOOL_NAMES.filter(
    (name) => ownership?.explicit.has(name) && (observed.has(name) || ownership.published?.has(name) === false),
  );
}

function publishActiveTools(pi: ExtensionAPI, names: string[], before: readonly string[]) {
  pi.setActiveTools(names);
  recordOwnership(pi, before);
}

function recordOwnership(pi: ExtensionAPI, before: readonly string[]) {
  const names = pi.getActiveTools();
  const owner = sessionOwnerByApi.get(pi);
  if (!owner) return;
  const ownership: ActivationOwnership = ownedBySession.get(owner) ?? {
    explicit: new Set<string>(),
    owned: new Set<string>(),
  };
  const observed = new Set(before);
  for (const name of ownership.explicit) {
    // Absence after our own suppression is not a host withdrawal. Only a
    // previously published activation disappearing is observable withdrawal.
    if (!observed.has(name) && (ownership.published?.has(name as ChromeDevToolsToolName) ?? true))
      ownership.explicit.delete(name);
  }
  for (const name of before)
    if (CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName) && !ownership.owned.has(name))
      ownership.explicit.add(name);
  if (chromeDevtoolsToolMode(pi) !== "codemode") {
    for (const name of names)
      if (CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName) && !ownership.explicit.has(name))
        ownership.owned.add(name);
  }
  if (chromeDevtoolsToolMode(pi) === "codemode") ownership.owned.clear();
  const published = new Set(names);
  ownership.published = new Set(CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => published.has(name)));
  ownedBySession.set(owner, ownership);
  persistOwnership(pi, ownership);
}

function ownershipData(ownership: ActivationOwnership) {
  return {
    version: 1,
    explicit: CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => ownership.explicit.has(name)),
    owned: CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => ownership.owned.has(name)),
    available: ownership.available
      ? CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => ownership.available?.has(name))
      : undefined,
    mode: ownership.mode,
    published: ownership.published
      ? CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => ownership.published?.has(name))
      : undefined,
  };
}

class ActivationProvenanceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function formatProvenanceWarning(error: ActivationProvenanceError) {
  return sanitizeChromeDevtoolsDisplay(
    `Activation ownership could not be saved: ${error.message}. Activation is not rolled back; durable ownership may be incomplete until a later loader call or lifecycle update retries successfully.`,
  );
}

function publishLifecycleTools(pi: ExtensionAPI, names: string[], before: readonly string[]) {
  try {
    publishActiveTools(pi, names, before);
  } catch (error) {
    if (!(error instanceof ActivationProvenanceError)) throw error;
    // Exposure has already succeeded. Lifecycle events are not rejected saves;
    // keep the accepted policy and let callers warn without stopping setup.
    return formatProvenanceWarning(error);
  }
}

function persistOwnership(pi: ExtensionAPI, ownership: ActivationOwnership) {
  ownership.available = new Set(configuredChromeDevtoolsTools(pi));
  ownership.mode = chromeDevtoolsToolMode(pi);
  const data = ownershipData(ownership);
  const serialized = JSON.stringify(data);
  if (ownership.serialized === serialized) return;
  try {
    pi.appendEntry(PROVENANCE_ENTRY, data);
    ownership.serialized = serialized;
  } catch (error) {
    // Pi can advance its in-memory branch before disk persistence throws. Force
    // recovery to append its policy even when it matches the last saved record.
    ownership.serialized = undefined;
    throw new ActivationProvenanceError(error);
  }
}

function restoredOwnership(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): ActivationOwnership | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PROVENANCE_ENTRY) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    const record = data as Record<string, unknown>;
    const validNames = (value: unknown): value is ChromeDevToolsToolName[] =>
      Array.isArray(value) &&
      value.length <= CHROME_DEVTOOLS_TOOL_NAMES.length &&
      value.every((name) => CHROME_DEVTOOLS_TOOL_NAMES.includes(name));
    if (
      record.version !== 1 ||
      !validNames(record.explicit) ||
      !validNames(record.owned) ||
      (record.available !== undefined && !validNames(record.available)) ||
      (record.published !== undefined && !validNames(record.published)) ||
      (record.mode !== undefined && record.mode !== "codemode" && record.mode !== "lazy" && record.mode !== "direct") ||
      record.owned.some((name) => (record.explicit as string[]).includes(name))
    )
      return undefined;
    const restored = {
      explicit: new Set<string>(record.explicit),
      owned: new Set<string>(record.owned),
      available: validNames(record.available) ? new Set(record.available) : undefined,
      mode: record.mode as ChromeDevToolsToolMode | undefined,
      published: validNames(record.published) ? new Set(record.published) : undefined,
    };
    return { ...restored, serialized: JSON.stringify(ownershipData(restored)) };
  }
  return undefined;
}
const definitionsByApi = new WeakMap<ExtensionAPI, ToolDefinition[]>();

export function registerChromeDevtoolsCapabilities(pi: ExtensionAPI, tools: ToolDefinition[]) {
  definitionsByApi.set(pi, tools);
  for (const tool of tools) pi.registerTool({ ...tool, exposure: "codemode", defaultActive: false });
  // Keep a carried-over predecessor loader observable until session_start.
  // Pi drops unregistered/hidden active names while rebuilding on /reload.
  pi.registerTool({
    ...createChromeDevtoolsLoadTool(pi),
    exposure: "codemode",
    defaultActive: false,
    promptSnippet: undefined,
    promptGuidelines: undefined,
  });
  loaderRegistered.add(pi);
}

export function chromeDevtoolsToolMode(pi: ExtensionAPI): ChromeDevToolsToolMode {
  return modeByApi.get(pi) ?? "codemode";
}

function refreshExposure(pi: ExtensionAPI) {
  const available = effectiveAvailableTools(pi);
  const mode = chromeDevtoolsToolMode(pi);
  for (const tool of definitionsByApi.get(pi) ?? []) {
    pi.registerTool({
      ...tool,
      defaultActive: false,
      exposure: available.has(tool.name as ChromeDevToolsToolName)
        ? mode === "codemode"
          ? "codemode"
          : "direct"
        : "hidden",
    });
  }
  if (mode === "lazy") {
    pi.registerTool({ ...createChromeDevtoolsLoadTool(pi), defaultActive: false });
    loaderRegistered.add(pi);
  } else if (loaderRegistered.has(pi)) {
    pi.registerTool({
      ...createChromeDevtoolsLoadTool(pi),
      exposure: "hidden",
      promptSnippet: undefined,
      promptGuidelines: undefined,
    });
  }
}

const SEARCH_TEXT: Record<ChromeDevToolsToolName, string> = {
  chrome_devtools_list_pages: "list open inspectable chrome browser pages tabs targets",
  chrome_devtools_select_page: "select choose active chrome browser page tab target",
  chrome_devtools_navigate: "navigate open create chrome browser page url website",
  chrome_devtools_evaluate: "evaluate run javascript expression dom inspect chrome browser page",
  chrome_devtools_screenshot: "capture screenshot png image visual chrome browser page",
  chrome_devtools_webmcp_list_tools: "list discover page provided website webmcp tools capabilities experimental",
  chrome_devtools_webmcp_call_tool: "call invoke page provided website webmcp tool confirmation experimental",
};

export function setChromeDevtoolsSessionOwner(
  pi: ExtensionAPI,
  owner: object,
  entries?: readonly { type: string; customType?: string; data?: unknown }[],
) {
  sessionOwnerByApi.set(pi, owner);
  if (entries) {
    const ownership = restoredOwnership(entries);
    if (ownership) {
      const pending = ownedBySession.get(owner);
      // An append can advance this branch before persistence fails. Restoring
      // that same validated policy must not erase its pending retry marker.
      if (
        pending &&
        pending.serialized === undefined &&
        ownership.serialized === JSON.stringify(ownershipData(pending))
      )
        ownership.serialized = undefined;
      ownedBySession.set(owner, ownership);
    } else {
      // Tree navigation can reuse a manager while replacing its active branch.
      // Never lend another branch's activation or policy provenance to it.
      ownedBySession.delete(owner);
      availableToolsByApi.delete(pi);
      modeByApi.delete(pi);
    }
  }
  const ownership = ownedBySession.get(owner);
  if (ownership?.available) setAvailableTools(pi, [...ownership.available]);
  if (ownership?.mode) modeByApi.set(pi, ownership.mode);
}

export function initializeAvailableChromeDevtoolsTools(pi: ExtensionAPI) {
  if (availableToolsByApi.has(pi)) return;
  // Availability is configuration, not the provider-visible declaration list.
  // In particular, codemode starts with no active capability names.
  setAvailableTools(pi, CHROME_DEVTOOLS_TOOL_NAMES);
}

export function configureChromeDevtoolsToolExposure(
  pi: ExtensionAPI,
  availableTools: readonly ChromeDevToolsToolName[],
  model?: ExtensionContext["model"],
  mode: ChromeDevToolsToolMode = "codemode",
) {
  modeByApi.set(pi, mode);
  setAvailableTools(pi, availableTools);
  const available = effectiveAvailableTools(pi);
  const lazyExposure = mode === "lazy" && supportsNativeDeferredToolLoading(model);
  lazyExposureByApi.set(pi, lazyExposure);
  const before = pi.getActiveTools();
  const owner = sessionOwnerByApi.get(pi);
  let ownership = owner ? ownedBySession.get(owner) : undefined;
  if (owner && !ownership && before.includes(CHROME_DEVTOOLS_LOAD_TOOL_NAME)) {
    // The predecessor always activated its loader but had no provenance store.
    // With no public activation-origin API, this loader cohort is migrated as
    // extension-owned; capability-only host selections remain explicit.
    ownership = {
      explicit: new Set(),
      owned: new Set(before.filter((name) => CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName))),
    };
    ownedBySession.set(owner, ownership);
  }
  const owned = ownership?.owned;
  const exposedTools =
    mode === "codemode"
      ? unique([...before.filter((name) => !owned?.has(name)), ...retainedExplicitTools(pi, before)]).filter((name) =>
          available.has(name as ChromeDevToolsToolName),
        )
      : lazyExposure
        ? []
        : CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
  const nonCapabilityTools = pi
    .getActiveTools()
    .filter((name) => !CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName));
  refreshExposure(pi);
  const target = new Set([
    ...nonCapabilityTools.filter((name) => name !== CHROME_DEVTOOLS_LOAD_TOOL_NAME),
    ...(mode === "lazy" ? [CHROME_DEVTOOLS_LOAD_TOOL_NAME] : []),
    ...exposedTools,
  ]);
  return publishLifecycleTools(pi, unique([...before.filter((name) => target.has(name)), ...target]), before);
}

export function requireEagerChromeDevtoolsToolExposure(pi: ExtensionAPI) {
  if (chromeDevtoolsToolMode(pi) !== "lazy") return;
  lazyExposureByApi.set(pi, false);
  const active = pi.getActiveTools();
  const available = availableChromeDevtoolsTools(pi);
  return publishLifecycleTools(pi, unique([...active, CHROME_DEVTOOLS_LOAD_TOOL_NAME, ...available]), active);
}

export function applyAvailableChromeDevtoolsTools(
  pi: ExtensionAPI,
  availableTools: readonly ChromeDevToolsToolName[],
  restoredActiveTools?: readonly string[],
) {
  setAvailableTools(pi, availableTools);
  const available = effectiveAvailableTools(pi);
  const lazyExposure = lazyExposureByApi.get(pi) === true;
  const before = restoredActiveTools
    ? restoreCapabilityPositions(pi.getActiveTools(), restoredActiveTools, available)
    : pi.getActiveTools();
  const active = before.filter(
    (name) =>
      !CHROME_DEVTOOLS_TOOL_NAMES.includes(name as ChromeDevToolsToolName) ||
      (lazyExposure && available.has(name as ChromeDevToolsToolName)),
  );
  const mode = chromeDevtoolsToolMode(pi);
  const eagerTools =
    mode === "codemode"
      ? unique([...before, ...retainedExplicitTools(pi, before)]).filter((name) =>
          available.has(name as ChromeDevToolsToolName),
        )
      : lazyExposure
        ? []
        : CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => available.has(name));
  refreshExposure(pi);
  const target = new Set([
    ...active.filter((name) => name !== CHROME_DEVTOOLS_LOAD_TOOL_NAME),
    ...(mode === "lazy" ? [CHROME_DEVTOOLS_LOAD_TOOL_NAME] : []),
    ...eagerTools,
  ]);
  publishActiveTools(pi, unique([...before.filter((name) => target.has(name)), ...target]), before);
}

export function chromeDevtoolsToolExposureMode(pi: ExtensionAPI) {
  return chromeDevtoolsToolMode(pi) === "codemode"
    ? "codemode"
    : lazyExposureByApi.get(pi) === true
      ? "native deferred"
      : "eager";
}

export function supportsNativeDeferredToolLoading(model: ExtensionContext["model"]): boolean {
  // Without native system-message updates, Pi folds later tool additions into
  // the leading request and invalidates its cached prefix.
  if (!model || compatBoolean(model.compat, "supportsMidConvoSystemMessages") !== true) return false;
  if (model.api === "anthropic-messages") return compatBoolean(model.compat, "supportsMidConvoToolChanges") === true;
  if (model.api === "openai-completions") return compatBoolean(model.compat, "supportsMidConvoToolAdditions") === true;
  if (
    model.api === "openai-responses" ||
    model.api === "openai-codex-responses" ||
    model.api === "azure-openai-responses"
  ) {
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

export function previousChromeDevtoolsTools(pi: ExtensionAPI) {
  if (availableToolsByApi.has(pi)) return configuredChromeDevtoolsTools(pi);
  // An unknown catalog cannot authorize new capabilities. Preserve only names
  // already explicitly active; this fallback is used for invalid settings only.
  const active = new Set(pi.getActiveTools());
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => active.has(name));
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
      let provenanceWarning: string | undefined;
      try {
        if (added.length > 0) {
          publishActiveTools(pi, unique([...active, ...added]), active);
        } else {
          const ownership = ownedBySession.get(ctx.sessionManager);
          if (ownership && ownership.serialized === undefined) recordOwnership(pi, active);
        }
      } catch (error) {
        if (!(error instanceof ActivationProvenanceError)) throw error;
        // Native loading must remain additive. Activation succeeded; do not
        // remove tools or claim it failed because its bookkeeping could not save.
        provenanceWarning = formatProvenanceWarning(error);
      }

      const text =
        matches.length === 0
          ? "No available Chrome DevTools tools matched the query."
          : added.length > 0
            ? `Loaded Chrome DevTools tools: ${added.join(", ")}`
            : `Matching Chrome DevTools tools are already loaded: ${matches.join(", ")}`;
      return {
        content: [{ type: "text" as const, text: provenanceWarning ? `${text}\nWarning: ${provenanceWarning}` : text }],
        details: { matches, added, ...(provenanceWarning ? { provenanceWarning } : {}) },
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

// Rollback may reinsert capabilities, but must not undo unrelated additions,
// removals, or ordering changes made while persistence was awaiting I/O.
function restoreCapabilityPositions(
  current: readonly string[],
  previous: readonly string[],
  available: ReadonlySet<ChromeDevToolsToolName>,
) {
  const restored = [...current];
  for (const [index, name] of previous.entries()) {
    if (!available.has(name as ChromeDevToolsToolName) || restored.includes(name)) continue;
    const following = previous.slice(index + 1).find((candidate) => restored.includes(candidate));
    const insertion = following === undefined ? restored.length : restored.indexOf(following);
    restored.splice(insertion, 0, name);
  }
  return restored;
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
