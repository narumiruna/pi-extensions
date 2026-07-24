import {
	exactAlias,
	optionBoolean,
	optionMap,
	optionString,
	optionStrings,
	safeMetadata,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

export async function collectExecution(context: CollectorContext): Promise<MutableModuleSnapshot> {
	if (context.input.reason === "periodic" && context.input.previous) {
		const retained: MutableModuleSnapshot = {};
		for (const name of ["os", "container", "hostname", "username"] as const) {
			const values = context.input.previous.modules[name];
			if (context.needs(name) && values) retained[name] = { ...values };
		}
		return retained;
	}
	const result: MutableModuleSnapshot = {};
	if (context.needs("os")) result.os = await osValues(context);
	const container = context.needs("container") ? await containerValues(context) : undefined;
	if (container) result.container = container;
	const hostname = context.needs("hostname") ? hostnameValues(context) : undefined;
	if (hostname) result.hostname = hostname;
	const username = context.needs("username") ? usernameValues(context) : undefined;
	if (username) result.username = username;
	return result;
}

async function osValues(context: CollectorContext): Promise<Record<string, string>> {
	const wsl = Boolean(safeMetadata(context.input.environment.WSL_DISTRO_NAME));
	const type = wsl ? "wsl" : platformType(context.input.platform);
	const details = context.input.platform === "linux" ? await linuxRelease(context) : {};
	const symbols = optionMap(context, "os", "symbols");
	return {
		type,
		name: details.name ?? platformName(context.input.platform, wsl),
		...(details.version ? { version: details.version } : {}),
		...(details.edition ? { edition: details.edition } : {}),
		...(details.codename ? { codename: details.codename } : {}),
		...(Object.hasOwn(symbols, type) && safeMetadata(symbols[type])
			? { symbol: safeMetadata(symbols[type]) as string }
			: {}),
	};
}

async function linuxRelease(context: CollectorContext): Promise<{
	name?: string;
	version?: string;
	edition?: string;
	codename?: string;
}> {
	const source = await context.fs.readFile("/etc/os-release", 16 * 1024);
	if (!source) return {};
	const values: Record<string, string> = {};
	for (const line of source.split(/\r?\n/u)) {
		const match = /^([A-Z_]+)=(.*)$/u.exec(line);
		if (!match?.[1] || match[2] === undefined) continue;
		const value = safeMetadata(match[2].replace(/^['"]|['"]$/gu, ""));
		if (value) values[match[1]] = value;
	}
	return {
		name: values.NAME,
		version: values.VERSION_ID,
		edition: values.ID,
		codename: values.VERSION_CODENAME,
	};
}

async function containerValues(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	const env = context.input.environment;
	if (safeMetadata(env.REMOTE_CONTAINERS) || safeMetadata(env.CODESPACES)) {
		return { name: "Dev Container", type: "devcontainer" };
	}
	const wsl = safeMetadata(env.WSL_DISTRO_NAME);
	if (wsl) return { name: `WSL ${wsl}`, type: "wsl" };
	if (await context.fs.fileExists("/.dockerenv")) return { name: "Docker", type: "docker" };
	if (await context.fs.fileExists("/run/.containerenv")) return { name: "Podman", type: "podman" };
	const systemd = safeMetadata(await context.fs.readFile("/run/systemd/container", 256));
	return systemd ? { name: systemd, type: "container" } : undefined;
}

function hostnameValues(context: CollectorContext): Record<string, string> | undefined {
	const ssh = isSsh(context);
	if (optionBoolean(context, "hostname", "ssh_only") && !ssh) return undefined;
	const raw = safeMetadata(context.input.hostname);
	if (!raw) return undefined;
	const aliases = optionMap(context, "hostname", "aliases");
	let hostname = exactAlias(raw, aliases) ?? raw;
	if (hostname === raw) {
		const trimAt = optionString(context, "hostname", "trim_at");
		const index = trimAt ? hostname.indexOf(trimAt) : -1;
		if (index > 0) hostname = hostname.slice(0, index);
	}
	return { hostname, ssh_symbol: ssh ? "🌐 " : "" };
}

function usernameValues(context: CollectorContext): Record<string, string> | undefined {
	const user = safeMetadata(context.input.username);
	if (!user) return undefined;
	const env = context.input.environment;
	const login = safeMetadata(env.LOGNAME ?? env.USER ?? env.USERNAME);
	const privileged = /^(?:root|administrator)$/iu.test(user);
	const detected = optionStrings(context, "username", "detect_env_vars").some(
		(name) => safeMetadata(env[name]) !== undefined,
	);
	if (
		!optionBoolean(context, "username", "show_always") &&
		!isSsh(context) &&
		!privileged &&
		!(login && login !== user) &&
		!detected
	) {
		return undefined;
	}
	return { user: exactAlias(user, optionMap(context, "username", "aliases")) ?? user };
}

function isSsh(context: CollectorContext): boolean {
	return Boolean(
		safeMetadata(context.input.environment.SSH_CONNECTION) ||
			safeMetadata(context.input.environment.SSH_TTY),
	);
}

function platformType(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	return platform;
}

function platformName(platform: NodeJS.Platform, wsl: boolean): string {
	if (wsl) return "WSL";
	if (platform === "darwin") return "macOS";
	if (platform === "win32") return "Windows";
	if (platform === "linux") return "Linux";
	return platform;
}
