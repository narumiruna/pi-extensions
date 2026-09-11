import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_BROWSER_HOST,
  DEFAULT_BROWSER_PORT,
  type EffectiveBrowserSettings,
  parseConfiguredPort,
} from "./settings.js";

export const DEFAULT_HOST = DEFAULT_BROWSER_HOST;
export const DEFAULT_PORT = DEFAULT_BROWSER_PORT;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
export const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
export const DEFAULT_ENDPOINT_RETRY_MS = 250;
export const MANAGED_BROWSER_PROFILE_PREFIX = "pi-chrome-devtools-profile-";
export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
export const BROWSER_SHUTDOWN_WAIT_MS = 1_500;

export interface DevToolsPage {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface ChromeDevToolsState {
  host: string;
  port: number;
  configuredPort: number;
  hostConfigured: boolean;
  portConfigured: boolean;
  autoLaunchEnabled: boolean;
  endpointSource: EffectiveBrowserSettings["endpointSource"];
  autoLaunchSource: EffectiveBrowserSettings["autoLaunchSource"];
  browserExecutable?: string;
  extensionPaths: string[];
  browserExecutableSource: EffectiveBrowserSettings["executablePathSource"];
  extensionPathsSource: EffectiveBrowserSettings["extensionPathsSource"];
  settingsFilePath?: string;
  projectSettingsFilePath?: string;
  projectSettingsTrusted: boolean;
  activePageId?: string;
  managedBrowser?: ManagedBrowser;
  launchPromise?: Promise<void>;
  lastLaunchAttempt?: BrowserLaunchAttempt;
  shuttingDown: boolean;
  sessionGeneration: number;
  sessionController: AbortController;
  settingsNotice?: string;
}

export interface ManagedBrowser {
  process: ChildProcess;
  userDataDir: string;
  port?: number;
  exited: boolean;
  ready: boolean;
  ownerGeneration: number;
  sessionOwner?: object;
  cleanupPromise?: Promise<void>;
}

export interface BrowserLaunchAttempt {
  candidateLabels: string[];
  mode: "dynamic-port" | "explicit-port";
  selectedCandidate?: string;
  userDataDir?: string;
  lastError?: string;
}

export interface BrowserCandidateDefinition {
  label: string;
  executable: string;
  source: "env" | "path" | "wellKnownPath";
}

export interface BrowserCandidate extends BrowserCandidateDefinition {
  resolvedExecutable: string;
}

export { parseConfiguredPort };

export const state: ChromeDevToolsState = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  configuredPort: DEFAULT_PORT,
  hostConfigured: false,
  portConfigured: false,
  autoLaunchEnabled: true,
  endpointSource: "default",
  autoLaunchSource: "default",
  extensionPaths: [],
  browserExecutableSource: "default",
  extensionPathsSource: "default",
  projectSettingsTrusted: false,
  shuttingDown: false,
  sessionGeneration: 0,
  sessionController: new AbortController(),
};

interface WebMcpSessionRuntime {
  controller: AbortController;
  enabled: boolean;
  controllers: Set<AbortController>;
  generation: number;
  sessionGeneration: number;
}

const webMcpRuntimeByOwner = new WeakMap<object, WebMcpSessionRuntime>();

export function setWebMcpSessionOwner(owner: object) {
  const runtime = webMcpRuntime(owner);
  runtime.enabled = false;
  runtime.sessionGeneration += 1;
}

export function beginWebMcpOperation(owner: object, toolSignal?: AbortSignal) {
  const runtime = webMcpRuntime(owner);
  const controller = new AbortController();
  runtime.controllers.add(controller);
  const signals = [controller.signal, runtime.controller.signal];
  if (toolSignal) signals.push(toolSignal);
  const signal = AbortSignal.any(signals);
  return {
    signal,
    owner,
    sessionGeneration: runtime.sessionGeneration,
    webMcpGeneration: runtime.generation,
    dispose() {
      runtime.controllers.delete(controller);
    },
  };
}

export function invalidateWebMcpOperations(owner: object, reason: string) {
  const runtime = webMcpRuntime(owner);
  runtime.generation += 1;
  const controllers = [...runtime.controllers];
  runtime.controllers.clear();
  const error = new DOMException(reason, "AbortError");
  runtime.controller.abort(error);
  runtime.controller = new AbortController();
  for (const controller of controllers) controller.abort(error);
}

export function currentWebMcpGeneration(owner: object) {
  return webMcpRuntime(owner).generation;
}

export function webMcpSessionSignal(owner: object) {
  return webMcpRuntime(owner).controller.signal;
}

export function applyRuntimeWebMcpSetting(enabled: boolean, owner: object) {
  const runtime = webMcpRuntime(owner);
  if (runtime.enabled !== enabled) {
    invalidateWebMcpOperations(owner, `WebMCP ${enabled ? "enabled" : "disabled"}`);
  }
  runtime.enabled = enabled;
}

export function webMcpEnabled(owner: object) {
  return webMcpRuntime(owner).enabled;
}

export function webMcpOperationIsCurrent(operation: {
  owner: object;
  sessionGeneration: number;
  webMcpGeneration: number;
}) {
  const runtime = webMcpRuntime(operation.owner);
  return operation.sessionGeneration === runtime.sessionGeneration && operation.webMcpGeneration === runtime.generation;
}

function webMcpRuntime(owner: object) {
  const existing = webMcpRuntimeByOwner.get(owner);
  if (existing) return existing;
  const created: WebMcpSessionRuntime = {
    controller: new AbortController(),
    controllers: new Set(),
    enabled: false,
    generation: 0,
    sessionGeneration: 0,
  };
  webMcpRuntimeByOwner.set(owner, created);
  return created;
}

export function applyRuntimeBrowserSettings(
  browser: EffectiveBrowserSettings,
  paths: { user: string; project?: string },
  projectTrusted: boolean,
) {
  state.host = browser.host;
  state.port = browser.port;
  state.configuredPort = browser.port;
  state.hostConfigured = browser.hostConfigured;
  state.portConfigured = browser.portConfigured;
  state.autoLaunchEnabled = browser.autoLaunchEnabled;
  state.endpointSource = browser.endpointSource;
  state.autoLaunchSource = browser.autoLaunchSource;
  state.browserExecutable = browser.executablePath;
  state.extensionPaths = [...browser.extensionPaths];
  state.browserExecutableSource = browser.executablePathSource;
  state.extensionPathsSource = browser.extensionPathsSource;
  state.settingsFilePath = paths.user;
  state.projectSettingsFilePath = paths.project;
  state.projectSettingsTrusted = projectTrusted;
}
