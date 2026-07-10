import type { ChildProcess } from "node:child_process";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9222;
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
	browserExecutable?: string;
	activePageId?: string;
	managedBrowser?: ManagedBrowser;
	launchPromise?: Promise<void>;
	lastLaunchAttempt?: BrowserLaunchAttempt;
	shuttingDown: boolean;
	settingsNotice?: string;
}

export interface ManagedBrowser {
	process: ChildProcess;
	userDataDir: string;
	port?: number;
	exited: boolean;
	ready: boolean;
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

export function parseConfiguredPort(value: string | undefined) {
	if (value === undefined) return undefined;
	const trimmedValue = value.trim();
	if (!/^\d+$/.test(trimmedValue)) return undefined;
	const port = Number(trimmedValue);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return port;
}

const configuredHost = process.env.PI_CHROME_DEVTOOLS_HOST ?? DEFAULT_HOST;
const configuredPortOverride = parseConfiguredPort(process.env.PI_CHROME_DEVTOOLS_PORT);
const configuredPort = configuredPortOverride ?? DEFAULT_PORT;

export const state: ChromeDevToolsState = {
	host: configuredHost,
	port: configuredPort,
	configuredPort,
	hostConfigured: process.env.PI_CHROME_DEVTOOLS_HOST !== undefined,
	portConfigured: configuredPortOverride !== undefined,
	autoLaunchEnabled: process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH !== "0",
	browserExecutable: process.env.PI_CHROME_DEVTOOLS_BROWSER,
	shuttingDown: false,
};
