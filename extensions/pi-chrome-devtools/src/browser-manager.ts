import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import {
	BROWSER_SHUTDOWN_WAIT_MS,
	DEFAULT_ENDPOINT_RETRY_MS,
	DEFAULT_ENDPOINT_WAIT_MS,
	DEFAULT_HOST,
	DEFAULT_HTTP_TIMEOUT_MS,
	DEVTOOLS_ACTIVE_PORT_FILE,
	MANAGED_BROWSER_PROFILE_PREFIX,
	state,
	type BrowserCandidate,
	type BrowserCandidateDefinition,
	type DevToolsPage,
	type ManagedBrowser,
} from "./runtime.js";

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function normalizePathForComparison(value: string) {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

export async function ensureDevToolsEndpoint(waitMs = DEFAULT_ENDPOINT_WAIT_MS) {
	if (canAutoLaunchBrowser()) {
		try {
			await withEndpointRetry(() => fetchDevToolsJson<unknown>("/json/version"), waitMs);
			return;
		} catch (error) {
			if (shouldAutoLaunchAfterEndpointError(error)) {
				await ensureManagedBrowserLaunched(waitMs);
				return;
			}
			throw error;
		}
	}

	try {
		await fetchDevToolsJson<unknown>("/json/version");
	} catch (error) {
		if (isRetryableEndpointError(error)) return;
		throw error;
	}
}

async function ensureManagedBrowserLaunched(waitMs: number) {
	if (state.launchPromise) return state.launchPromise;
	if (state.managedBrowser && !state.managedBrowser.exited && state.managedBrowser.ready) return;
	if (state.managedBrowser) {
		await shutdownManagedBrowser(state.managedBrowser, { awaitLaunch: false });
	}
	throwIfBrowserLaunchCancelled();

	state.launchPromise = launchManagedBrowser(waitMs).finally(() => {
		state.launchPromise = undefined;
	});
	return state.launchPromise;
}

async function launchManagedBrowser(waitMs: number) {
	throwIfBrowserLaunchCancelled();
	const candidateDefinitions = browserCandidateDefinitions();
	const candidates = await resolveBrowserCandidates(candidateDefinitions);
	throwIfBrowserLaunchCancelled();
	state.lastLaunchAttempt = {
		candidateLabels: candidateDefinitions.map(formatBrowserCandidateDefinition),
		mode: state.portConfigured ? "explicit-port" : "dynamic-port",
	};

	if (candidates.length === 0) {
		throw new DevToolsEndpointError(noBrowserCandidateMessage(candidateDefinitions));
	}

	let lastError: unknown;
	for (const candidate of candidates) {
		throwIfBrowserLaunchCancelled();
		try {
			await launchBrowserCandidate(candidate, waitMs);
			state.lastLaunchAttempt = {
				...state.lastLaunchAttempt,
				selectedCandidate: formatBrowserCandidate(candidate),
				userDataDir: state.managedBrowser?.userDataDir,
			};
			return;
		} catch (error) {
			lastError = error;
			state.lastLaunchAttempt = {
				...state.lastLaunchAttempt,
				lastError: formatError(error),
			};
		}
	}

	throw new DevToolsEndpointError(
		[
			"Unable to auto-launch a Chromium-family browser for Chrome DevTools.",
			`Tried: ${candidates.map(formatBrowserCandidate).join(", ")}`,
			lastError ? `Last error: ${formatError(lastError)}` : undefined,
			launchHint(),
			endpointConfigHint(),
		]
			.filter(Boolean)
			.join("\n"),
	);
}

async function launchBrowserCandidate(candidate: BrowserCandidate, waitMs: number) {
	throwIfBrowserLaunchCancelled();
	const userDataDir = await mkdtemp(join(tmpdir(), MANAGED_BROWSER_PROFILE_PREFIX));
	let managedBrowser: ManagedBrowser | undefined;
	try {
		const portArgument = state.portConfigured ? String(state.port) : "0";
		const args = [
			`--remote-debugging-port=${portArgument}`,
			`--user-data-dir=${userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		];
		throwIfBrowserLaunchCancelled();
		const child = spawn(candidate.resolvedExecutable, args, { shell: false, stdio: "ignore" });
		const launchedBrowser: ManagedBrowser = { process: child, userDataDir, exited: false, ready: false };
		managedBrowser = launchedBrowser;
		state.managedBrowser = launchedBrowser;

		child.once("exit", () => {
			launchedBrowser.exited = true;
			launchedBrowser.ready = false;
			if (!state.portConfigured && launchedBrowser.port === state.port) {
				state.port = state.configuredPort;
			}
		});

		await waitForBrowserSpawn(child);
		if (state.portConfigured) {
			launchedBrowser.port = state.port;
		} else {
			launchedBrowser.port = await readManagedBrowserPort(userDataDir, launchedBrowser, waitMs);
			state.port = launchedBrowser.port;
		}
		await waitForDevToolsEndpoint(waitMs, launchedBrowser);
		launchedBrowser.ready = true;
	} catch (error) {
		if (managedBrowser) await shutdownManagedBrowser(managedBrowser, { awaitLaunch: false });
		else await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

function waitForBrowserSpawn(child: ChildProcess) {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			child.off("error", onError);
			child.off("spawn", onSpawn);
			callback();
		};
		const onError = (error: Error) => settle(() => reject(error));
		const onSpawn = () => settle(resolve);
		child.once("error", onError);
		child.once("spawn", onSpawn);
	});
}

async function readManagedBrowserPort(
	userDataDir: string,
	managedBrowser: ManagedBrowser,
	waitMs: number,
) {
	const activePortFile = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
	const deadline = Date.now() + waitMs;
	while (true) {
		throwIfManagedBrowserExited(managedBrowser);
		const text = await readFile(activePortFile, "utf8").catch((error: unknown) => {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		const portText = text?.split(/\r?\n/, 1)[0]?.trim();
		const port = Number(portText);
		if (Number.isInteger(port) && port > 0) return port;

		throwIfBrowserLaunchCancelled();
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new DevToolsEndpointError(
				[
					"Timed out waiting for auto-launched browser DevToolsActivePort.",
					`Expected file: ${activePortFile}`,
					launchHint(),
				].join("\n"),
			);
		}
		await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
	}
}

async function waitForDevToolsEndpoint(waitMs: number, managedBrowser: ManagedBrowser) {
	const deadline = Date.now() + waitMs;
	while (true) {
		throwIfManagedBrowserExited(managedBrowser);
		try {
			await fetchDevToolsJson<unknown>("/json/version");
			return;
		} catch (error) {
			if (!isRetryableEndpointError(error)) throw error;
		}

		throwIfBrowserLaunchCancelled();
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new DevToolsEndpointError(
				[
					`Timed out waiting for auto-launched browser at ${devToolsEndpoint()}.`,
					launchHint(),
				].join("\n"),
			);
		}
		await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
	}
}

function throwIfManagedBrowserExited(managedBrowser: ManagedBrowser) {
	if (!managedBrowser.exited) return;
	throw new DevToolsEndpointError("Auto-launched browser exited before DevTools became available.");
}

function throwIfBrowserLaunchCancelled() {
	if (!state.shuttingDown) return;
	throw new DevToolsEndpointError("Chrome DevTools browser launch cancelled during shutdown.");
}

export async function shutdownManagedBrowser(
	managedBrowser = state.managedBrowser,
	options: { awaitLaunch?: boolean; cancelLaunch?: boolean } = {},
) {
	if (options.cancelLaunch) state.shuttingDown = true;
	if (options.awaitLaunch !== false) {
		await state.launchPromise?.catch(() => undefined);
		managedBrowser = managedBrowser ?? state.managedBrowser;
	}
	if (!managedBrowser) return;
	if (state.managedBrowser === managedBrowser) state.managedBrowser = undefined;

	if (!managedBrowser.exited) {
		killManagedBrowserProcess(managedBrowser);
		await waitForManagedBrowserExit(managedBrowser, BROWSER_SHUTDOWN_WAIT_MS).catch(() => {
			killManagedBrowserProcess(managedBrowser, "SIGKILL");
		});
	}
	await rm(managedBrowser.userDataDir, { recursive: true, force: true }).catch(() => undefined);
	if (!state.portConfigured && managedBrowser.port === state.port) state.port = state.configuredPort;
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

export async function fetchDevToolsJson<T>(path: string, init?: RequestInit) {
	const url = `${devToolsEndpoint()}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
		});
	} catch (error) {
		throw new DevToolsEndpointError(endpointConnectionErrorMessage(error), {
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
			[
				`Chrome DevTools endpoint ${url} returned invalid JSON: ${formatError(error)}.`,
				endpointConfigHint(),
			].join("\n"),
		);
	}
}

export async function withEndpointRetry<T>(operation: () => Promise<T>, waitMs: number) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableEndpointError(error)) throw error;

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw error;

			await sleep(Math.min(DEFAULT_ENDPOINT_RETRY_MS, remainingMs));
		}
	}
}

function isRetryableEndpointError(error: unknown) {
	return error instanceof DevToolsEndpointError && error.retryable;
}

function isLaunchableEndpointError(error: unknown) {
	return error instanceof DevToolsEndpointError && error.launchable;
}

function shouldAutoLaunchAfterEndpointError(error: unknown) {
	if (!canAutoLaunchBrowser()) return false;
	if (isLaunchableEndpointError(error)) return true;

	// After the attach-first attempt (including its retry window, when applicable) fails, treat any
	// DevTools endpoint error on an unpinned port as a conflict we can avoid with a dynamic port.
	return !state.portConfigured && error instanceof DevToolsEndpointError;
}

function canAutoLaunchBrowser() {
	return state.autoLaunchEnabled && isLocalDevToolsHost(state.host);
}

function endpointConnectionErrorMessage(error: unknown) {
	const reason = isTimeoutError(error) ? "request timed out" : "connection failed";
	return [
		`Cannot connect to Chrome DevTools endpoint at ${devToolsEndpoint()} (${reason}).`,
		launchHint(),
		endpointConfigHint(),
	].join("\n");
}

function isTimeoutError(error: unknown) {
	return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

export function devToolsEndpoint() {
	return `http://${formatHostForUrl(state.host)}:${state.port}`;
}

export function formatHostForUrl(host: string) {
	if (host.startsWith("[") && host.endsWith("]")) return host;
	return host.includes(":") ? `[${host}]` : host;
}

export function endpointSourceLabel() {
	const hostSource = state.hostConfigured ? "PI_CHROME_DEVTOOLS_HOST" : "default host";
	const portSource = state.portConfigured ? "PI_CHROME_DEVTOOLS_PORT" : "default/dynamic port";
	return `${hostSource}; ${portSource}`;
}

export function launchModeLabel() {
	if (!isLocalDevToolsHost(state.host)) return "manual remote endpoint";
	if (!state.autoLaunchEnabled) return "manual; auto-launch disabled";
	if (state.managedBrowser && !state.managedBrowser.exited) {
		return state.portConfigured ? "auto-launched on explicit port" : "auto-launched on dynamic port";
	}
	return state.portConfigured ? "attach first; auto-launch explicit port" : "attach first; auto-launch dynamic port";
}

export function launchAttemptLines() {
	if (!state.lastLaunchAttempt) return [];

	const lines = [`Last launch attempt: ${state.lastLaunchAttempt.mode}`];
	if (state.lastLaunchAttempt.selectedCandidate) {
		lines.push(`Launched browser: ${state.lastLaunchAttempt.selectedCandidate}`);
	} else {
		lines.push(`Tried browser candidates: ${state.lastLaunchAttempt.candidateLabels.join(", ")}`);
	}
	if (state.lastLaunchAttempt.userDataDir) {
		lines.push(`Managed browser profile: ${state.lastLaunchAttempt.userDataDir}`);
	}
	if (state.lastLaunchAttempt.lastError) {
		lines.push(`Last launch error: ${state.lastLaunchAttempt.lastError}`);
	}
	return lines;
}

export function launchHint() {
	if (!isLocalDevToolsHost(state.host)) {
		return `Remote/non-local endpoints are not auto-launched. Start a browser with CDP enabled at ${devToolsEndpoint()}.`;
	}
	if (!state.autoLaunchEnabled) {
		return `Auto-launch is disabled. Start a browser manually: ${chromeLaunchCommand()}`;
	}
	const managedMode = state.portConfigured ? `port ${state.port}` : "a dynamic DevTools port";
	return `If no endpoint is available, Pi will auto-launch a Chromium-family browser with ${managedMode} and an isolated temp profile. Manual command: ${chromeLaunchCommand()}`;
}

export function browserCandidateHint() {
	return `Browser candidates: ${browserCandidateDefinitions().map((candidate) => candidate.label).join(", ")}`;
}

export function chromeLaunchCommand() {
	const executable = state.browserExecutable ?? defaultManualBrowserExecutable();
	const dataDir =
		process.platform === "win32" ? "%TEMP%\\pi-chrome-devtools" : "/tmp/pi-chrome-devtools";
	return `${quoteCommandPart(executable)} --remote-debugging-port=${state.port} --user-data-dir=${dataDir}`;
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
	return "Set PI_CHROME_DEVTOOLS_HOST and PI_CHROME_DEVTOOLS_PORT for a manual endpoint, PI_CHROME_DEVTOOLS_BROWSER to choose an executable, or PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0 to disable auto-launch.";
}

export function isLocalDevToolsHost(host: string) {
	const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
	return ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(normalizedHost);
}

function browserCandidateDefinitions(): BrowserCandidateDefinition[] {
	const explicitCandidate = explicitBrowserCandidateDefinition();
	if (explicitCandidate.length > 0) return explicitCandidate;

	return uniqueBrowserCandidates(platformBrowserCandidateDefinitions());
}

function explicitBrowserCandidateDefinition(): BrowserCandidateDefinition[] {
	if (!state.browserExecutable) return [];
	return [{ label: "PI_CHROME_DEVTOOLS_BROWSER", executable: state.browserExecutable, source: "env" }];
}

function platformBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
	if (process.platform === "darwin") {
		return [
			{
				label: "Google Chrome",
				executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				source: "wellKnownPath",
			},
			{
				label: "Chromium",
				executable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
				source: "wellKnownPath",
			},
			{
				label: "Brave Browser",
				executable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
				source: "wellKnownPath",
			},
			{
				label: "Microsoft Edge",
				executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				source: "wellKnownPath",
			},
		];
	}

	if (process.platform === "win32") {
		return windowsBrowserCandidateDefinitions();
	}

	return [
		{ label: "Google Chrome", executable: "google-chrome", source: "path" },
		{ label: "Google Chrome Stable", executable: "google-chrome-stable", source: "path" },
		{ label: "Chromium", executable: "chromium", source: "path" },
		{ label: "Chromium Browser", executable: "chromium-browser", source: "path" },
		{ label: "Brave Browser", executable: "brave-browser", source: "path" },
		{ label: "Brave", executable: "brave", source: "path" },
		{ label: "Microsoft Edge", executable: "microsoft-edge", source: "path" },
		{ label: "Microsoft Edge Stable", executable: "microsoft-edge-stable", source: "path" },
	];
}

function windowsBrowserCandidateDefinitions(): BrowserCandidateDefinition[] {
	const programFiles = [
		process.env.PROGRAMFILES,
		process.env["PROGRAMFILES(X86)"],
		process.env.LOCALAPPDATA,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	const wellKnownPaths = programFiles.flatMap((root) => [
		join(root, "Google", "Chrome", "Application", "chrome.exe"),
		join(root, "Chromium", "Application", "chrome.exe"),
		join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
	]);
	return [
		...wellKnownPaths.map((executable) => ({
			label: browserLabelFromExecutable(executable),
			executable,
			source: "wellKnownPath" as const,
		})),
		{ label: "Google Chrome", executable: "chrome.exe", source: "path" },
		{ label: "Chromium", executable: "chromium.exe", source: "path" },
		{ label: "Brave Browser", executable: "brave.exe", source: "path" },
		{ label: "Microsoft Edge", executable: "msedge.exe", source: "path" },
	];
}

function browserLabelFromExecutable(executable: string) {
	const normalizedExecutable = normalizePathForComparison(executable);
	if (normalizedExecutable.includes("brave")) return "Brave Browser";
	if (normalizedExecutable.includes("edge") || normalizedExecutable.includes("msedge")) {
		return "Microsoft Edge";
	}
	if (normalizedExecutable.includes("chromium")) return "Chromium";
	return "Google Chrome";
}

function uniqueBrowserCandidates(candidates: BrowserCandidateDefinition[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = normalizePathForComparison(candidate.executable);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function resolveBrowserCandidates(definitions: BrowserCandidateDefinition[]) {
	const candidates: BrowserCandidate[] = [];
	for (const definition of definitions) {
		const resolvedExecutable = await resolveBrowserExecutable(definition.executable);
		if (!resolvedExecutable) continue;
		candidates.push({ ...definition, resolvedExecutable });
	}
	return uniqueBrowserCandidatesByResolvedPath(candidates);
}

function uniqueBrowserCandidatesByResolvedPath(candidates: BrowserCandidate[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = normalizePathForComparison(resolve(candidate.resolvedExecutable));
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function resolveBrowserExecutable(executable: string) {
	if (hasPathSeparator(executable) || isAbsolute(executable)) {
		const resolvedExecutable = isAbsolute(executable) ? executable : resolve(executable);
		return (await canAccessExecutable(resolvedExecutable)) ? resolvedExecutable : undefined;
	}

	for (const directory of executableSearchPath()) {
		for (const executableName of executableSearchNames(executable)) {
			const candidate = join(directory, executableName);
			if (await canAccessExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

function hasPathSeparator(path: string) {
	return path.includes("/") || path.includes("\\");
}

function executableSearchPath() {
	return (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0);
}

function executableSearchNames(executable: string) {
	if (process.platform !== "win32" || /\.[a-z0-9]+$/i.test(executable)) return [executable];
	return [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`];
}

async function canAccessExecutable(path: string) {
	try {
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function formatBrowserCandidate(candidate: BrowserCandidate) {
	return `${candidate.label} (${candidate.resolvedExecutable})`;
}

function formatBrowserCandidateDefinition(candidate: BrowserCandidateDefinition) {
	return `${candidate.label} (${candidate.executable})`;
}

function noBrowserCandidateMessage(candidateDefinitions: BrowserCandidateDefinition[]) {
	return [
		"Cannot auto-launch Chrome DevTools because no Chromium-family browser executable was found.",
		`Tried: ${candidateDefinitions.map(formatBrowserCandidateDefinition).join(", ")}`,
		endpointConfigHint(),
	].join("\n");
}

export function formatPageListItem(page: DevToolsPage) {
	return `- ${page.id}: ${page.title || "(untitled)"} ${page.url}`;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

