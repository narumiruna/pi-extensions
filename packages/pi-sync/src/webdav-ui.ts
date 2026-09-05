import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptSecret } from "./secret-input.js";
import {
	addStorageConnection,
	addSyncSetup,
	saveNewV3Settings,
	updateStorageConnection,
	updateSyncSetup,
} from "./settings-management.js";
import { DEFAULT_SYNC_INCLUDE } from "./sync-policy.js";
import type { PartialConfig } from "./types.js";
import {
	normalizeWebDavPath,
	normalizeWebDavUrl,
	validateWebDavCredentials,
	validateWebDavNamespace,
} from "./webdav-config.js";

export async function showWebDavSetup(
	ctx: ExtensionCommandContext,
	targetName: string,
	signal?: AbortSignal,
) {
	const url = await requiredInput(
		ctx,
		"WebDAV collection URL",
		"https://cloud.example.com/remote.php/dav/files/user",
		signal,
	);
	if (!url) return false;
	const username = await requiredInput(ctx, "WebDAV username", "user", signal);
	if (!username) return false;
	const password = await awaitActive(signal, promptSecret(ctx, "WebDAV password", { signal }));
	if (password === undefined) return false;
	const location = await chooseDestination(ctx, targetName, signal);
	if (!location) return false;
	const connection = validateConnection(ctx, url, username, password);
	const destination = validateDestination(ctx, location.path);
	if (!connection || !destination) return false;
	const content = await chooseContent(ctx, signal);
	if (!content) return false;
	const automatic = await select(
		ctx,
		"Automatic sync for this setup",
		["Enable automatic sync", "Keep automatic sync off", "Cancel"],
		signal,
	);
	if (!automatic || automatic === "Cancel") return false;
	const sessions = await chooseSessions(ctx, signal);
	if (sessions === undefined) return false;
	const profileName = "webdav";
	const review = await select(
		ctx,
		[
			"Review WebDAV setup",
			"",
			`Sync setup: ${safe(targetName)}`,
			`Storage connection: ${profileName} (WebDAV)`,
			`URL: ${displayUrl(connection.url)}`,
			`Storage location: ${safe(destination.path)}`,
			"Username: stored in the private settings file (value hidden)",
			"Password: configured (value hidden)",
			`Conditional writes: /sync doctor verifies atomic If-Match and If-None-Match support before publication.`,
			`Included content: ${content.length} built-in groups · Sessions: ${sessions ? "On — privacy warning acknowledged" : "Off"}`,
			`Automatic sync: ${automatic === "Enable automatic sync" ? "On" : "Off"}`,
		].join("\n"),
		["Save setup", "Cancel"],
		signal,
	);
	if (review !== "Save setup") return false;
	throwIfAborted(signal);
	await awaitActive(
		signal,
		saveNewV3Settings(
			{
				setupName: targetName,
				connectionName: profileName,
				connection: {
					type: "webdav",
					url: connection.url,
					credentials: { username: connection.username, password: connection.password ?? "" },
				},
				setup: {
					storage: { connection: profileName, path: destination.path },
					sync: {
						include: [...content, ...(sessions ? ["sessions"] : [])],
						automatic: automatic === "Enable automatic sync",
					},
				},
			},
			signal,
		),
	);
	ctx.ui.notify(`Sync setup “${safe(targetName)}” is ready. Use Sync now when ready.`, "info");
	return true;
}

export async function showAddWebDavTarget(
	ctx: ExtensionCommandContext,
	name: string,
	profile: string,
	signal?: AbortSignal,
) {
	const location = await chooseDestination(ctx, name, signal);
	if (!location) return false;
	const destination = validateDestination(ctx, location.path);
	if (!destination) return false;
	const content = await chooseContent(ctx, signal);
	if (!content) return false;
	const review = await select(
		ctx,
		`Review WebDAV sync setup\n\nSync setup: ${safe(name)}\nStorage connection: ${safe(profile)}\nStorage location: ${safe(destination.path)}\nIncluded content: ${content.length} built-in groups · Sessions: Off\nAutomatic sync: Off\nAdding this setup does not sync or modify remote data.`,
		["Add sync setup", "Cancel"],
		signal,
	);
	if (review !== "Add sync setup") return false;
	throwIfAborted(signal);
	await awaitActive(
		signal,
		addSyncSetup(
			name,
			{
				storage: { connection: profile, path: destination.path },
				sync: { include: content, automatic: false },
			},
			signal,
		),
	);
	ctx.ui.notify(`Added sync setup “${safe(name)}”.`, "info");
	return true;
}

export async function showEditWebDavTarget(
	ctx: ExtensionCommandContext,
	partial: PartialConfig,
	signal?: AbortSignal,
) {
	const remotePath = await requiredInput(ctx, "WebDAV storage path", partial.storagePath, signal);
	if (!remotePath) return false;
	const destination = validateDestination(ctx, remotePath);
	if (!destination) return false;
	const review = await select(
		ctx,
		`Review sync setup “${safe(partial.setupName)}”\n\nStorage path: ${safe(partial.storagePath)} → ${safe(destination.path)}\nSaving changes the future storage location only; it does not move or delete remote data.`,
		["Save sync setup", "Cancel"],
		signal,
	);
	if (review !== "Save sync setup") return false;
	throwIfAborted(signal);
	await awaitActive(
		signal,
		updateSyncSetup(
			partial.setupName,
			(setup) => ({
				...setup,
				storage: { ...setup.storage, path: destination.path },
			}),
			{ expectedStorage: partial, signal },
		),
	);
	ctx.ui.notify(`Saved sync setup “${safe(partial.setupName)}”.`, "info");
	return true;
}

export async function showAddWebDavStorageProfile(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	const name = await requiredInput(ctx, "Name this storage connection", "webdav", signal);
	if (!name) return false;
	const url = await requiredInput(
		ctx,
		"WebDAV collection URL",
		"https://cloud.example.com/dav",
		signal,
	);
	if (!url) return false;
	const username = await requiredInput(ctx, "WebDAV username", "user", signal);
	if (!username) return false;
	const password = await awaitActive(signal, promptSecret(ctx, "WebDAV password", { signal }));
	if (password === undefined) return false;
	const connection = validateConnection(ctx, url, username, password);
	if (!connection) return false;
	const review = await select(
		ctx,
		`Review storage connection\n\nName: ${safe(name)}\nType: WebDAV\nURL: ${displayUrl(connection.url)}\nUsername: stored privately (value hidden)\nPassword: configured (value hidden)\nAdding a connection does not contact the server or start syncing.`,
		["Add storage connection", "Cancel"],
		signal,
	);
	if (review !== "Add storage connection") return false;
	throwIfAborted(signal);
	await awaitActive(
		signal,
		addStorageConnection(
			name,
			{
				type: "webdav",
				url: connection.url,
				credentials: { username: connection.username, password: connection.password ?? "" },
			},
			signal,
		),
	);
	ctx.ui.notify(`Added storage connection “${safe(name)}”.`, "info");
	return true;
}

export async function showEditWebDavStorageProfile(
	ctx: ExtensionCommandContext,
	name: string,
	profile: Record<string, unknown>,
	signal?: AbortSignal,
	affectedSetups?: string[],
) {
	const url = await requiredInput(
		ctx,
		"WebDAV collection URL",
		String(profile.url ?? "https://cloud.example.com/dav"),
		signal,
	);
	if (!url) return false;
	const username = await requiredInput(
		ctx,
		"WebDAV username",
		String(profile.username ?? "user"),
		signal,
	);
	if (!username) return false;
	let password: string | undefined;
	let replacePassword = false;
	if (typeof profile.password === "string" && profile.password.length > 0) {
		const passwordAction = await select(
			ctx,
			"WebDAV password",
			["Keep current password", "Replace password", "Cancel"],
			signal,
		);
		if (!passwordAction || passwordAction === "Cancel") return false;
		replacePassword = passwordAction === "Replace password";
	} else {
		replacePassword = true;
	}
	if (replacePassword) {
		password = await awaitActive(signal, promptSecret(ctx, "New WebDAV password", { signal }));
		if (password === undefined) return false;
	}
	const connection = validateConnection(ctx, url, username, password);
	if (!connection) return false;
	const review = await select(
		ctx,
		`Review storage connection\n\nStorage connection: ${safe(name)}\nURL: ${displayUrl(String(profile.url ?? "https://invalid.invalid"))} → ${displayUrl(connection.url)}\nUsername: stored privately (value hidden)\nPassword: ${replacePassword ? "will be replaced" : "unchanged"} (value hidden)\nAffected sync setups: ${affectedSetups && affectedSetups.length > 0 ? affectedSetups.map(safe).join(", ") : "None"}\nSaving changes future storage access for every affected setup; it does not move remote data.`,
		["Save storage connection", "Cancel"],
		signal,
	);
	if (review !== "Save storage connection") return false;
	throwIfAborted(signal);
	await awaitActive(
		signal,
		updateStorageConnection(
			name,
			(current) => {
				if (current.type !== "webdav") {
					throw new Error("Storage connection type changed; reopen it.");
				}
				return {
					...current,
					url: connection.url,
					credentials: {
						...current.credentials,
						username: connection.username,
						password: replacePassword
							? (connection.password ?? current.credentials.password)
							: current.credentials.password,
					},
				};
			},
			affectedSetups,
			signal,
		),
	);
	ctx.ui.notify(`Saved storage connection “${safe(name)}”.`, "info");
	return true;
}

async function chooseDestination(
	ctx: ExtensionCommandContext,
	targetName: string,
	signal?: AbortSignal,
) {
	const remotePath = await requiredInput(
		ctx,
		"WebDAV storage path",
		`pi-sync/${targetName}`,
		signal,
	);
	return remotePath ? validateDestination(ctx, remotePath) : undefined;
}

async function chooseContent(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	const choice = await select(
		ctx,
		"Choose an initial sync preset",
		["Recommended Pi settings", "Minimal settings", "Cancel"],
		signal,
	);
	if (!choice || choice === "Cancel") return undefined;
	return choice === "Minimal settings" ? ["settings.json", "AGENTS.md"] : [...DEFAULT_SYNC_INCLUDE];
}

async function chooseSessions(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	const choice = await select(
		ctx,
		"Session conversations\n\nSessions can contain prompts, tool output, paths, screenshots, and secrets.",
		["Keep sessions off (recommended)", "Include session conversations", "Cancel"],
		signal,
	);
	if (!choice || choice === "Cancel") return undefined;
	if (choice !== "Include session conversations") return false;
	return confirm(
		ctx,
		"Include session conversations?",
		"I understand that session JSONL can contain prompts, tool output, paths, screenshots, and secrets.",
		signal,
	);
}

async function requiredInput(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
	signal?: AbortSignal,
) {
	const value = await awaitActive(signal, ctx.ui.input(title, placeholder, { signal }));
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) {
		ctx.ui.notify(`${title} is required.`, "warning");
		return undefined;
	}
	return trimmed;
}

async function select(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
	signal?: AbortSignal,
) {
	return awaitActive(signal, ctx.ui.select(title, options, { signal }));
}

async function confirm(
	ctx: ExtensionCommandContext,
	title: string,
	message: string,
	signal?: AbortSignal,
) {
	return awaitActive(signal, ctx.ui.confirm(title, message, { signal }));
}

async function awaitActive<T>(signal: AbortSignal | undefined, operation: Promise<T>) {
	const result = await operation;
	throwIfAborted(signal);
	return result;
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function validateConnection(
	ctx: ExtensionCommandContext,
	url: string,
	username: string,
	password?: string,
) {
	try {
		const normalizedUrl = normalizeWebDavUrl(url);
		if (!normalizedUrl) throw new Error("WebDAV URL is required.");
		validateWebDavCredentials(username, password);
		return {
			url: normalizedUrl,
			username: username.trim(),
			...(password === undefined ? {} : { password }),
		};
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function validateDestination(ctx: ExtensionCommandContext, path: string, namespace?: string) {
	try {
		const basePath = normalizeWebDavPath(path);
		const normalizedPath = namespace
			? normalizeWebDavPath(`${basePath}/${namespace.trim()}`)
			: basePath;
		const resolvedNamespace = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
		validateWebDavNamespace(resolvedNamespace);
		return { path: normalizedPath, namespace: resolvedNamespace };
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function displayUrl(value: string) {
	try {
		return `${new URL(value).origin}/…`;
	} catch {
		return "invalid URL (value hidden)";
	}
}

function safe(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Settings values are untrusted terminal input.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
}
