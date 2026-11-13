import { type ChildProcess, execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCandidateDefinitions, resolveBrowserCandidates } from "./browser-candidates.js";
import { browserWebSocketIdentity, waitForBrowserStartup } from "./browser-startup.js";
import {
  BROWSER_SHUTDOWN_WAIT_MS,
  type BrowserCandidate,
  type BrowserCandidateDefinition,
  type BrowserLaunchAttempt,
  DEFAULT_ENDPOINT_RETRY_MS,
  DEFAULT_ENDPOINT_WAIT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  type DevToolsPage,
  invalidateWebMcpOperations,
  MANAGED_BROWSER_PROFILE_PREFIX,
  type ManagedBrowser,
  state,
} from "./runtime.js";
import type { EffectiveBrowserSettings } from "./settings.js";

// Endpoint attachment, managed launch, selected-port publication, and shutdown intentionally remain
// together because they form one ownership state machine behind the testable operations boundary.
interface BrowserSpawnOptions {
  shell: false;
  stdio: ["ignore", "ignore", "pipe"];
}

export interface BrowserManagerOperations {
  access(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  allocatePort(host: string): Promise<number>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  spawn(executable: string, args: string[], options: BrowserSpawnOptions): ChildProcess;
  inspectBrowserVersion(executable: string, signal: AbortSignal): Promise<string>;
  isPortAvailable(host: string, port: number): Promise<boolean>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const DEFAULT_BROWSER_MANAGER_OPERATIONS: BrowserManagerOperations = {
  access,
  mkdtemp,
  allocatePort: allocateBrowserPort,
  rm: (path, options) => rm(path, options),
  fetch: (input, init) => fetch(input, init),
  spawn,
  inspectBrowserVersion,
  isPortAvailable,
  sleep: abortableSleep,
};

let browserManagerOperations = DEFAULT_BROWSER_MANAGER_OPERATIONS;

interface ManagedBrowserScope {
  browser: EffectiveBrowserSettings;
  controller: AbortController;
  generation: number;
  launchPromise?: Promise<void>;
  managedBrowser?: ManagedBrowser;
  port: number;
  lastLaunchAttempt?: BrowserLaunchAttempt;
}

const managedBrowserScopes = new WeakMap<object, ManagedBrowserScope>();

function cloneBrowserSettings(browser: EffectiveBrowserSettings): EffectiveBrowserSettings {
  return { ...browser, extensionPaths: [...browser.extensionPaths] };
}

function runtimeBrowserSettings(): EffectiveBrowserSettings {
  return {
    endpoint: `http://${formatHostForUrl(state.host)}:${state.configuredPort}`,
    host: state.host,
    port: state.configuredPort,
    hostConfigured: state.hostConfigured,
    portConfigured: state.portConfigured,
    autoLaunchEnabled: state.autoLaunchEnabled,
    ...(state.browserExecutable ? { executablePath: state.browserExecutable } : {}),
    extensionPaths: [...state.extensionPaths],
    endpointSource: state.endpointSource,
    autoLaunchSource: state.autoLaunchSource,
    executablePathSource: state.browserExecutableSource,
    extensionPathsSource: state.extensionPathsSource,
  };
}

function managedBrowserScope(owner: object) {
  const existing = managedBrowserScopes.get(owner);
  if (existing) return existing;
  const browser = runtimeBrowserSettings();
  const created: ManagedBrowserScope = {
    browser,
    controller: new AbortController(),
    generation: 0,
    port: browser.port,
  };
  managedBrowserScopes.set(owner, created);
  return created;
}

export function startManagedBrowserSession(owner: object) {
  const scope = managedBrowserScope(owner);
  scope.controller.abort(new DOMException("Chrome DevTools session replaced", "AbortError"));
  scope.controller = new AbortController();
  scope.generation += 1;
  scope.lastLaunchAttempt = undefined;
}

export function syncManagedBrowserSettings(owner: object, browser: EffectiveBrowserSettings) {
  const scope = managedBrowserScope(owner);
  scope.browser = cloneBrowserSettings(browser);
  scope.port = browser.port;
}

export function browserSettingsForOwner(owner?: object) {
  return owner ? managedBrowserScope(owner).browser : runtimeBrowserSettings();
}

export function managedBrowserExtensionPaths(owner?: object) {
  return browserSettingsForOwner(owner).extensionPaths;
}

export function managedBrowserExtensionPathsSource(owner?: object) {
  return browserSettingsForOwner(owner).extensionPathsSource;
}

export function managedBrowserForOwner(owner?: object) {
  if (!owner) return state.managedBrowser;
  const scopedBrowser = managedBrowserScope(owner).managedBrowser;
  if (scopedBrowser) return scopedBrowser;
  return state.managedBrowser?.sessionOwner === owner ? state.managedBrowser : undefined;
}

function setManagedBrowser(owner: object | undefined, browser: ManagedBrowser | undefined) {
  if (owner) managedBrowserScope(owner).managedBrowser = browser;
  else state.managedBrowser = browser;
}

function launchPromiseForOwner(owner?: object) {
  return owner ? managedBrowserScope(owner).launchPromise : state.launchPromise;
}

function setLaunchPromise(owner: object | undefined, launchPromise: Promise<void> | undefined) {
  if (owner) managedBrowserScope(owner).launchPromise = launchPromise;
  else state.launchPromise = launchPromise;
}

function managedBrowserPort(owner?: object) {
  return owner ? managedBrowserScope(owner).port : state.port;
}

function managedBrowserConfiguredPort(owner?: object) {
  return browserSettingsForOwner(owner).port;
}

function managedBrowserPortConfigured(owner?: object) {
  return browserSettingsForOwner(owner).portConfigured;
}

function setManagedBrowserPort(owner: object | undefined, port: number) {
  if (owner) managedBrowserScope(owner).port = port;
  else state.port = port;
}

function lastLaunchAttempt(owner?: object) {
  return owner ? managedBrowserScope(owner).lastLaunchAttempt : state.lastLaunchAttempt;
}

function setLastLaunchAttempt(owner: object | undefined, attempt: BrowserLaunchAttempt | undefined) {
  if (owner) managedBrowserScope(owner).lastLaunchAttempt = attempt;
  else state.lastLaunchAttempt = attempt;
}

export function setBrowserManagerOperationsForTests(overrides: Partial<BrowserManagerOperations>) {
  const previous = browserManagerOperations;
  browserManagerOperations = { ...DEFAULT_BROWSER_MANAGER_OPERATIONS, ...overrides };
  return () => {
    browserManagerOperations = previous;
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function ensureDevToolsEndpoint(
  waitMs = DEFAULT_ENDPOINT_WAIT_MS,
  callerSignal?: AbortSignal,
  owner?: object,
) {
  callerSignal?.throwIfAborted();
  if (extensionsConfigured(owner)) {
    validateExtensionLaunchMode(owner);
    await ensureManagedBrowserLaunched(waitMs, callerSignal, owner);
    return;
  }
  const pendingLaunch = launchPromiseForOwner(owner);
  if (pendingLaunch) {
    await waitForCaller(pendingLaunch, callerSignal);
    return;
  }
  if (canAutoLaunchBrowser(owner)) {
    try {
      await withEndpointRetry(
        () => fetchDevToolsJson<unknown>("/json/version", { signal: callerSignal }, owner),
        waitMs,
        callerSignal,
      );
    } catch (error) {
      if (shouldAutoLaunchAfterEndpointError(error, owner)) {
        await ensureManagedBrowserLaunched(waitMs, callerSignal, owner);
        return;
      }
      throw error;
    }
    // An attach probe can finish after another caller starts a managed launch. It must
    // join that launch instead of bypassing the owned-browser identity check.
    const concurrentLaunch = launchPromiseForOwner(owner);
    if (concurrentLaunch) await waitForCaller(concurrentLaunch, callerSignal);
    return;
  }

  try {
    await fetchDevToolsJson<unknown>("/json/version", { signal: callerSignal }, owner);
  } catch (error) {
    if (isRetryableEndpointError(error)) return;
    throw error;
  }
}

function validateExtensionLaunchMode(owner?: object) {
  const browser = browserSettingsForOwner(owner);
  if (!isLocalDevToolsHost(browser.host)) {
    throw new DevToolsEndpointError(
      "Unpacked extensions require a local extension-owned managed browser; remote CDP endpoints cannot be modified.",
    );
  }
  if (!browser.autoLaunchEnabled) {
    throw new DevToolsEndpointError(
      "Auto-launch is required for unpacked extensions so Pi can create an isolated managed browser.",
    );
  }
  if (!browser.executablePath) {
    throw new DevToolsEndpointError(
      "Unpacked extensions require browser.executablePath for Chrome for Testing or Chromium in pi-chrome-devtools.json.",
    );
  }
}

async function ensureManagedBrowserLaunched(waitMs: number, callerSignal?: AbortSignal, owner?: object) {
  const existingLaunch = launchPromiseForOwner(owner);
  if (existingLaunch) {
    await waitForCaller(existingLaunch, callerSignal);
    return;
  }
  const existingBrowser = managedBrowserForOwner(owner);
  if (existingBrowser && !existingBrowser.exited && existingBrowser.ready) return;
  const generation = owner ? managedBrowserScope(owner).generation : state.sessionGeneration;
  const signal = owner ? managedBrowserScope(owner).controller.signal : state.sessionController.signal;
  throwIfBrowserLaunchCancelled(generation, signal, owner);

  const launchPromise = prepareManagedBrowserLaunch(waitMs, generation, signal, owner);
  const wrappedPromise = launchPromise.finally(() => {
    if (launchPromiseForOwner(owner) === wrappedPromise) setLaunchPromise(owner, undefined);
  });
  setLaunchPromise(owner, wrappedPromise);
  await waitForCaller(wrappedPromise, callerSignal);
}

function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => settle(() => reject(signal.reason));
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

async function prepareManagedBrowserLaunch(waitMs: number, generation: number, signal: AbortSignal, owner?: object) {
  const existingBrowser = managedBrowserForOwner(owner);
  if (existingBrowser) {
    await shutdownManagedBrowser(existingBrowser, { awaitLaunch: false, owner });
    throwIfBrowserLaunchCancelled(generation, signal, owner);
  }
  if (managedBrowserPortConfigured(owner)) {
    const available = await browserManagerOperations.isPortAvailable(
      browserSettingsForOwner(owner).host,
      managedBrowserPort(owner),
    );
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    if (!available) {
      throw new DevToolsEndpointError(
        `Cannot launch the extension-owned browser because explicit port ${managedBrowserPort(owner)} is already in use. Choose a free browser.endpoint port or reset the endpoint to use an automatically selected managed port.`,
      );
    }
  }
  return launchManagedBrowser(waitMs, generation, signal, owner);
}

async function launchManagedBrowser(waitMs: number, generation: number, signal: AbortSignal, owner?: object) {
  throwIfBrowserLaunchCancelled(generation, signal, owner);
  const candidateDefinitions = browserCandidateDefinitions(browserSettingsForOwner(owner));
  const candidates = await resolveBrowserCandidates(candidateDefinitions, browserManagerOperations.access, () =>
    throwIfBrowserLaunchCancelled(generation, signal, owner),
  );
  throwIfBrowserLaunchCancelled(generation, signal, owner);
  setLastLaunchAttempt(owner, {
    candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
    mode: managedBrowserPortConfigured(owner) ? "explicit-port" : "automatic-port",
  });

  if (candidates.length === 0) {
    throw new DevToolsEndpointError(noBrowserCandidateMessage(candidateDefinitions, owner));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    try {
      if (extensionsConfigured(owner)) await requireSupportedExtensionBrowser(candidate, generation, signal, owner);
      await launchBrowserCandidate(candidate, waitMs, generation, signal, owner);
      throwIfBrowserLaunchCancelled(generation, signal, owner);
      setLastLaunchAttempt(owner, {
        ...lastLaunchAttempt(owner),
        candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
        mode: managedBrowserPortConfigured(owner) ? "explicit-port" : "automatic-port",
        selectedCandidate: formatBrowserCandidate(candidate),
        userDataDir: managedBrowserForOwner(owner)?.userDataDir,
      });
      return;
    } catch (error) {
      try {
        throwIfBrowserLaunchCancelled(generation, signal, owner);
      } catch (cancellation) {
        setLastLaunchAttempt(owner, {
          ...(lastLaunchAttempt(owner) ?? {
            candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
            mode: managedBrowserPortConfigured(owner) ? "explicit-port" : "automatic-port",
          }),
          lastError: formatError(cancellation),
        });
        throw cancellation;
      }
      lastError = error;
      setLastLaunchAttempt(owner, {
        ...(lastLaunchAttempt(owner) ?? {
          candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
          mode: managedBrowserPortConfigured(owner) ? "explicit-port" : "automatic-port",
        }),
        lastError: formatError(error),
      });
    }
  }

  if (lastError instanceof DevToolsEndpointError && extensionsConfigured(owner)) throw lastError;
  throw new DevToolsEndpointError(
    [
      "Unable to auto-launch a Chromium-family browser for Chrome DevTools.",
      `Tried: ${candidates.map(formatBrowserCandidate).join(", ")}`,
      lastError ? `Last error: ${formatError(lastError)}` : undefined,
      launchHint(owner),
      endpointConfigHint(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function requireSupportedExtensionBrowser(
  candidate: BrowserCandidate,
  generation: number,
  signal: AbortSignal,
  owner?: object,
) {
  let version: string;
  try {
    version = (await browserManagerOperations.inspectBrowserVersion(candidate.resolvedExecutable, signal)).trim();
  } catch (error) {
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    throw new DevToolsEndpointError(
      `Unable to identify the configured extension browser ${candidate.resolvedExecutable}: ${formatError(error)}. Configure Chrome for Testing or Chromium.`,
    );
  }
  throwIfBrowserLaunchCancelled(generation, signal, owner);
  const classification = classifyExtensionBrowserVersion(version);
  if (!classification.supported) {
    throw new DevToolsEndpointError(
      `Unsupported browser for unpacked extensions: ${version || "unknown product"}. Configure Chrome for Testing or Chromium; branded Chrome may silently ignore extension startup flags.`,
    );
  }
}

export function classifyExtensionBrowserVersion(version: string): {
  supported: boolean;
  product: string;
} {
  if (/^(?:Google )?Chrome for Testing\b/i.test(version)) {
    return { supported: true, product: "Chrome for Testing" };
  }
  if (/^Chromium\b/i.test(version)) return { supported: true, product: "Chromium" };
  const product = version.trim().replace(/\s+\d+(?:\.\d+)*.*$/, "") || "Unknown";
  return { supported: false, product };
}

async function launchBrowserCandidate(
  candidate: BrowserCandidate,
  waitMs: number,
  generation: number,
  signal: AbortSignal,
  owner?: object,
) {
  throwIfBrowserLaunchCancelled(generation, signal, owner);
  const userDataDir = await browserManagerOperations.mkdtemp(join(tmpdir(), MANAGED_BROWSER_PROFILE_PREFIX));
  let managedBrowser: ManagedBrowser | undefined;
  try {
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    const port = managedBrowserPortConfigured(owner)
      ? managedBrowserPort(owner)
      : await browserManagerOperations.allocatePort(browserSettingsForOwner(owner).host);
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DevToolsEndpointError("Cannot launch a browser without a valid nonzero DevTools port.");
    }
    const args = buildManagedBrowserLaunchArguments(userDataDir, String(port), managedBrowserExtensionPaths(owner));
    const child = browserManagerOperations.spawn(candidate.resolvedExecutable, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const launchedBrowser: ManagedBrowser = {
      process: child,
      userDataDir,
      port,
      exited: false,
      ready: false,
      ownerGeneration: generation,
      ...(owner ? { sessionOwner: owner } : {}),
    };
    managedBrowser = launchedBrowser;
    setManagedBrowser(owner, launchedBrowser);

    child.once("exit", () => {
      if (managedBrowserForOwner(owner) === launchedBrowser && owner) {
        invalidateWebMcpOperations(owner, "Chrome DevTools managed browser exited");
      }
      launchedBrowser.exited = true;
      launchedBrowser.ready = false;
      if (!managedBrowserPortConfigured(owner) && launchedBrowser.port === managedBrowserPort(owner)) {
        setManagedBrowserPort(owner, managedBrowserConfiguredPort(owner));
      }
    });

    const browserIdentity = await waitForBrowserStartup(child, port, waitMs, signal);
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    setManagedBrowserPort(owner, port);
    await waitForDevToolsEndpoint(waitMs, launchedBrowser, browserIdentity, generation, signal, owner);
    throwIfBrowserLaunchCancelled(generation, signal, owner);
    throwIfManagedBrowserExited(launchedBrowser);
    launchedBrowser.ready = true;
  } catch (error) {
    if (managedBrowser) await shutdownManagedBrowser(managedBrowser, { awaitLaunch: false, owner });
    else {
      await browserManagerOperations.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export function buildManagedBrowserLaunchArguments(
  userDataDir: string,
  portArgument: string,
  extensionPaths: readonly string[],
) {
  const extensionList = extensionPaths.join(",");
  return [
    `--remote-debugging-port=${portArgument}`,
    `--user-data-dir=${userDataDir}`,
    ...(extensionPaths.length > 0
      ? [`--disable-extensions-except=${extensionList}`, `--load-extension=${extensionList}`]
      : []),
    // Chrome 138+ de-elevates when launched from an elevated process on Windows: the
    // spawned process relaunches a de-elevated child and exits immediately, which the
    // exit watchdog misreads as a failed launch.
    ...(process.platform === "win32" ? ["--do-not-de-elevate"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

async function waitForDevToolsEndpoint(
  waitMs: number,
  managedBrowser: ManagedBrowser,
  browserIdentity: string,
  generation: number,
  signal: AbortSignal,
  owner?: object,
) {
  const deadline = Date.now() + waitMs;
  while (true) {
    throwIfManagedBrowserExited(managedBrowser);
    try {
      const version = await fetchDevToolsJson<{ webSocketDebuggerUrl?: unknown } | null>(
        "/json/version",
        { signal },
        owner,
      );
      throwIfBrowserLaunchCancelled(generation, signal, owner);
      throwIfManagedBrowserExited(managedBrowser);
      if (browserWebSocketIdentity(version?.webSocketDebuggerUrl, managedBrowser.port ?? 0) !== browserIdentity) {
        throw new DevToolsEndpointError("DevTools endpoint does not match the auto-launched browser.");
      }
      return;
    } catch (error) {
      if (!isRetryableEndpointError(error)) throw error;
    }

    throwIfBrowserLaunchCancelled(generation, signal, owner);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new DevToolsEndpointError(
        [`Timed out waiting for auto-launched browser at ${devToolsEndpoint(owner)}.`, launchHint(owner)].join("\n"),
      );
    }
    await browserManagerOperations.sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs), signal);
  }
}

function throwIfManagedBrowserExited(managedBrowser: ManagedBrowser) {
  if (!managedBrowser.exited) return;
  throw new DevToolsEndpointError("Auto-launched browser exited before DevTools became available.");
}

function throwIfBrowserLaunchCancelled(generation: number, signal: AbortSignal, owner?: object) {
  const currentGeneration = owner ? managedBrowserScope(owner).generation : state.sessionGeneration;
  const shuttingDown = owner ? signal.aborted : state.shuttingDown;
  if (!shuttingDown && generation === currentGeneration && !signal.aborted) return;
  throw new DevToolsEndpointError(
    generation === currentGeneration
      ? "Chrome DevTools browser launch cancelled during shutdown."
      : "Chrome DevTools browser launch cancelled because the session was replaced.",
  );
}

export async function shutdownManagedBrowser(
  managedBrowser?: ManagedBrowser,
  options: { awaitLaunch?: boolean; cancelLaunch?: boolean; owner?: object } = {},
) {
  const owner = options.owner ?? managedBrowser?.sessionOwner;
  if (options.cancelLaunch) {
    if (owner) {
      const scope = managedBrowserScope(owner);
      scope.controller.abort(
        new DOMException("Chrome DevTools browser launch cancelled during shutdown", "AbortError"),
      );
      scope.generation += 1;
    } else {
      state.shuttingDown = true;
    }
  }
  managedBrowser ??= managedBrowserForOwner(owner);
  if (options.awaitLaunch !== false) {
    await launchPromiseForOwner(owner)?.catch(() => undefined);
    managedBrowser ??= managedBrowserForOwner(owner);
  }
  if (!managedBrowser) return;
  if (managedBrowser.cleanupPromise) return managedBrowser.cleanupPromise;

  const cleanup = cleanupManagedBrowser(managedBrowser, owner);
  managedBrowser.cleanupPromise = cleanup;
  return cleanup;
}

async function cleanupManagedBrowser(managedBrowser: ManagedBrowser, owner?: object) {
  if (managedBrowserForOwner(owner) === managedBrowser) {
    if (owner) invalidateWebMcpOperations(owner, "Chrome DevTools managed browser closed");
    if (state.managedBrowser === managedBrowser) state.managedBrowser = undefined;
    else setManagedBrowser(owner, undefined);
  }
  if (!managedBrowser.exited) {
    killManagedBrowserProcess(managedBrowser);
    await waitForManagedBrowserExit(managedBrowser, BROWSER_SHUTDOWN_WAIT_MS).catch(async () => {
      killManagedBrowserProcess(managedBrowser, "SIGKILL");
      await waitForManagedBrowserExit(managedBrowser, BROWSER_SHUTDOWN_WAIT_MS).catch(() => undefined);
    });
  }
  await browserManagerOperations
    .rm(managedBrowser.userDataDir, { recursive: true, force: true })
    .catch(() => undefined);
  if (!managedBrowserPortConfigured(owner) && managedBrowser.port === managedBrowserPort(owner)) {
    setManagedBrowserPort(owner, managedBrowserConfiguredPort(owner));
  }
}

function killManagedBrowserProcess(managedBrowser: ManagedBrowser, signal?: NodeJS.Signals) {
  try {
    managedBrowser.process.kill(signal);
  } catch {
    // Best-effort shutdown: the browser may have already exited or failed to spawn.
  }
}

function waitForManagedBrowserExit(managedBrowser: ManagedBrowser, waitMs: number) {
  if (managedBrowser.exited) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const settle = (callback: () => void) => {
      clearTimeout(timeout);
      managedBrowser.process.off("exit", onExitOrClose);
      managedBrowser.process.off("close", onExitOrClose);
      callback();
    };
    const onExitOrClose = () => {
      managedBrowser.exited = true;
      settle(resolve);
    };
    const timeout = setTimeout(
      () => settle(() => reject(new Error("Timed out waiting for browser shutdown."))),
      waitMs,
    );
    managedBrowser.process.once("exit", onExitOrClose);
    managedBrowser.process.once("close", onExitOrClose);
  });
}

export async function fetchDevToolsJson<T>(path: string, init?: RequestInit, owner?: object) {
  const url = `${devToolsEndpoint(owner)}${path}`;
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS);
    response = await browserManagerOperations.fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (error) {
    throw new DevToolsEndpointError(endpointConnectionErrorMessage(error, owner), {
      launchable: true,
      retryable: true,
    });
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).trim();
    const suffix = body ? `: ${body.slice(0, 200)}` : "";
    throw new DevToolsEndpointError(
      [
        `Chrome DevTools endpoint ${url} returned ${response.status} ${response.statusText}${suffix}.`,
        endpointConfigHint(),
      ].join("\n"),
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new DevToolsEndpointError(
      [`Chrome DevTools endpoint ${url} returned invalid JSON: ${formatError(error)}.`, endpointConfigHint()].join(
        "\n",
      ),
    );
  }
}

export async function withEndpointRetry<T>(operation: () => Promise<T>, waitMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + waitMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableEndpointError(error)) throw error;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;

      await browserManagerOperations.sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs), signal);
    }
  }
}

function isRetryableEndpointError(error: unknown) {
  return error instanceof DevToolsEndpointError && error.retryable;
}

function isLaunchableEndpointError(error: unknown) {
  return error instanceof DevToolsEndpointError && error.launchable;
}

function shouldAutoLaunchAfterEndpointError(error: unknown, owner?: object) {
  if (!canAutoLaunchBrowser(owner)) return false;
  if (isLaunchableEndpointError(error)) return true;

  // After the attach-first attempt (including its retry window, when applicable) fails, treat any
  // DevTools endpoint error on an unpinned port as a conflict we can avoid with an automatically selected port.
  return !managedBrowserPortConfigured(owner) && error instanceof DevToolsEndpointError;
}

function canAutoLaunchBrowser(owner?: object) {
  const browser = browserSettingsForOwner(owner);
  return browser.autoLaunchEnabled && isLocalDevToolsHost(browser.host);
}

function extensionsConfigured(owner?: object) {
  return managedBrowserExtensionPaths(owner).length > 0;
}

function endpointConnectionErrorMessage(error: unknown, owner?: object) {
  const reason = isTimeoutError(error) ? "request timed out" : "connection failed";
  return [
    `Cannot connect to Chrome DevTools endpoint at ${devToolsEndpoint(owner)} (${reason}).`,
    launchHint(owner),
    endpointConfigHint(),
  ].join("\n");
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

export function devToolsEndpoint(owner?: object) {
  return `http://${formatHostForUrl(browserSettingsForOwner(owner).host)}:${managedBrowserPort(owner)}`;
}

export function formatHostForUrl(host: string) {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

export function endpointSourceLabel(owner?: object) {
  return browserSettingsForOwner(owner).endpointSource;
}

export type BrowserLifecycleState = "starting" | "running" | "exited" | "failed" | "unobserved";

export function browserLifecycleState(owner?: object): BrowserLifecycleState {
  if (launchPromiseForOwner(owner)) return "starting";
  if (managedBrowserForOwner(owner)?.exited) return "exited";
  if (managedBrowserForOwner(owner)?.ready) return "running";
  if (lastLaunchAttempt(owner)?.lastError) return "failed";
  return "unobserved";
}

export function launchModeLabel(owner?: object) {
  const browser = browserSettingsForOwner(owner);
  const managedBrowser = managedBrowserForOwner(owner);
  if (extensionsConfigured(owner)) {
    if (!isLocalDevToolsHost(browser.host)) return "invalid; extensions require a local endpoint";
    if (!browser.autoLaunchEnabled) return "invalid; extensions require auto-launch";
    if (managedBrowser && !managedBrowser.exited) {
      return managedBrowserPortConfigured(owner)
        ? "extension-owned browser on explicit port"
        : "extension-owned browser on automatically selected port";
    }
    return managedBrowserPortConfigured(owner)
      ? "force extension-owned launch on explicit port"
      : "force extension-owned launch on automatically selected port";
  }
  if (!isLocalDevToolsHost(browser.host)) return "manual remote endpoint";
  if (!browser.autoLaunchEnabled) return "manual; auto-launch disabled";
  if (managedBrowser && !managedBrowser.exited) {
    return managedBrowserPortConfigured(owner)
      ? "auto-launched on explicit port"
      : "auto-launched on automatically selected port";
  }
  return managedBrowserPortConfigured(owner)
    ? "attach first; auto-launch explicit port"
    : "attach first; auto-launch on an automatically selected port";
}

export function launchAttemptLines(owner?: object) {
  const attempt = lastLaunchAttempt(owner);
  if (!attempt) return [];

  const lines = [`Last launch attempt: ${attempt.mode}`];
  if (attempt.selectedCandidate) {
    lines.push(`Launched browser: ${attempt.selectedCandidate}`);
  } else {
    lines.push(`Tried browser candidates: ${attempt.candidateLabels.join(", ")}`);
  }
  if (attempt.userDataDir) lines.push(`Managed browser profile: ${attempt.userDataDir}`);
  if (attempt.lastError) lines.push(`Last launch error: ${attempt.lastError}`);
  return lines;
}

export function launchHint(owner?: object) {
  const browser = browserSettingsForOwner(owner);
  if (extensionsConfigured(owner)) {
    return "Configured unpacked extensions force an isolated extension-owned launch; existing CDP browsers are never reused, modified, or closed.";
  }
  if (!isLocalDevToolsHost(browser.host)) {
    return `Remote/non-local endpoints are not auto-launched. Start a browser with CDP enabled at ${devToolsEndpoint(owner)}.`;
  }
  if (!browser.autoLaunchEnabled) {
    return `Auto-launch is disabled. Start a browser manually: ${chromeLaunchCommand(owner)}`;
  }
  const managedMode = managedBrowserPortConfigured(owner)
    ? `port ${managedBrowserPort(owner)}`
    : "an automatically selected nonzero DevTools port";
  return `If no endpoint is available, Pi will auto-launch a Chromium-family browser with ${managedMode} and an isolated temp profile. Manual command: ${chromeLaunchCommand(owner)}`;
}

export function browserCandidateHint(owner?: object) {
  if (extensionsConfigured(owner)) {
    return "Extension browser requirement: configure Chrome for Testing or Chromium with browser.executablePath; branded Chrome is rejected because it may ignore unpacked-extension flags.";
  }
  return `Browser candidates: ${browserCandidateDefinitions(browserSettingsForOwner(owner))
    .map((candidate) => candidate.label)
    .join(", ")}`;
}

export function chromeLaunchCommand(owner?: object) {
  const executable = browserSettingsForOwner(owner).executablePath ?? defaultManualBrowserExecutable();
  const dataDir = process.platform === "win32" ? "%TEMP%\\pi-chrome-devtools" : "/tmp/pi-chrome-devtools";
  return `${quoteCommandPart(executable)} --remote-debugging-port=${managedBrowserPort(owner)} --user-data-dir=${dataDir}`;
}

function defaultManualBrowserExecutable() {
  return process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "chrome.exe"
      : "google-chrome";
}

export function quoteCommandPart(value: string) {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function endpointConfigHint() {
  return "Configure browser.endpoint, browser.executablePath, and browser.autoLaunch in pi-chrome-devtools.json or the /chrome-devtools Settings flow.";
}

export function isLocalDevToolsHost(host: string) {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  return ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(normalizedHost);
}

function formatBrowserCandidate(candidate: BrowserCandidate) {
  return `${candidate.label} (${candidate.resolvedExecutable})`;
}

function formatBrowserCandidateDefinition(candidate: BrowserCandidateDefinition) {
  return `${candidate.label} (${candidate.executable})`;
}

function noBrowserCandidateMessage(candidateDefinitions: BrowserCandidateDefinition[], owner?: object) {
  if (extensionsConfigured(owner)) {
    return [
      "Cannot launch unpacked extensions because the configured browser executable was not found or is not executable.",
      `Tried: ${candidateDefinitions.map(formatBrowserCandidateDefinition).join(", ")}`,
      "Set browser.executablePath to an executable Chrome for Testing or Chromium binary.",
    ].join("\n");
  }
  return [
    "Cannot auto-launch Chrome DevTools because no Chromium-family browser executable was found.",
    `Tried: ${candidateDefinitions.map(formatBrowserCandidateDefinition).join(", ")}`,
    endpointConfigHint(),
  ].join("\n");
}

export function formatPageListItem(page: DevToolsPage) {
  return `- ${page.id}: ${page.title || "(untitled)"} ${page.url}`;
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(settleResolve, ms);
    const onAbort = () => settleReject(signal?.reason);
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    function settleResolve() {
      cleanup();
      resolveSleep();
    }
    function settleReject(reason: unknown) {
      cleanup();
      reject(reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function inspectBrowserVersion(executable: string, signal: AbortSignal) {
  return new Promise<string>((resolveVersion, reject) => {
    execFile(executable, ["--version"], { signal, timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolveVersion(`${stdout}${stderr}`.trim());
    });
  });
}

export async function allocateBrowserPort(host: string) {
  const port = await probeBrowserPort(host, 0);
  if (port === undefined) throw new Error("Cannot allocate an available DevTools port.");
  return port;
}

async function isPortAvailable(host: string, port: number) {
  return (await probeBrowserPort(host, port)) !== undefined;
}

// The probe always closes before publication. Chrome's startup identity check handles the
// unavoidable bind-close-spawn race without attaching to a competing CDP browser.
function probeBrowserPort(host: string, port: number) {
  return new Promise<number | undefined>((resolvePort, reject) => {
    const server = createServer();
    const normalizedHost = host.replace(/^\[(.*)]$/, "$1");
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolvePort(undefined);
      else reject(error);
    });
    server.listen(port, normalizedHost, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("DevTools port probe has no address."));
        else resolvePort(address.port);
      });
    });
  });
}

class DevToolsEndpointError extends Error {
  readonly retryable: boolean;
  readonly launchable: boolean;

  constructor(message: string, options: { retryable?: boolean; launchable?: boolean } = {}) {
    super(message);
    this.name = "DevToolsEndpointError";
    this.retryable = options.retryable ?? false;
    this.launchable = options.launchable ?? false;
  }
}
