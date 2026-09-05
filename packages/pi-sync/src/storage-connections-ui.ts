import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { isCloudflareR2Endpoint, readLocalConfigObject } from "./config.js";
import { showAddGitStorageProfile, showEditGitStorageProfile } from "./git-ui.js";
import { errorMessage, ownRecord, requiredInput, safeTerminalText } from "./manager-helpers.js";
import {
	applyS3CredentialUpdate,
	chooseS3Credentials,
	chooseS3CredentialUpdate,
} from "./s3-credentials-ui.js";
import {
	addStorageConnection,
	removeStorageConnection,
	updateStorageConnection,
} from "./settings-management.js";
import { showAddWebDavStorageProfile, showEditWebDavStorageProfile } from "./webdav-ui.js";

export async function showStorageConnections(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	let selectedName: string | undefined;
	const nameById = new Map<string, string>();
	type Screen = "list" | "detail";
	type Action = "add" | "select" | "edit" | "remove" | "back";
	const menu = defineMenu<
		Awaited<ReturnType<typeof loadStorageMenuState>>,
		Screen,
		Action,
		ExtensionCommandContext
	>({
		start: "list",
		screens: {
			list: ({ state }) => {
				nameById.clear();
				const names = Object.keys(state.profiles).sort((left, right) => left.localeCompare(right));
				return {
					kind: "actions",
					title: "Storage connections",
					lines: state.version3
						? []
						: ["Create version 3 settings before managing storage connections."],
					items: state.version3
						? [
								{ id: "add", label: "Add storage connection", action: "add" as const },
								...names.map((name, index) => {
									const id = `connection:${index}`;
									nameById.set(id, name);
									return {
										id,
										label: safeTerminalText(name),
										action: "select" as const,
									};
								}),
							]
						: [],
					hint: "back",
				};
			},
			detail: ({ state }) => ({
				kind: "actions",
				title: state.selected
					? `Storage connection “${safeTerminalText(state.selected.name)}”`
					: "Storage connection",
				lines: state.selected?.lines ?? ["This storage connection no longer exists."],
				items: state.selected
					? [
							{ id: "edit", label: "Edit storage connection…", action: "edit" },
							...(state.selected.usedBy.length === 0
								? [
										{
											id: "remove",
											label: "Remove storage connection…",
											action: "remove" as const,
										},
									]
								: []),
							{ id: "back", label: "Back", action: "back" },
						]
					: [{ id: "back", label: "Back", action: "back" }],
				hint: "back",
			}),
		},
		actions: {
			add: async () => {
				try {
					await showAddStorageConnection(ctx, signal);
				} catch (error) {
					if (!signal?.aborted) {
						ctx.ui.notify(
							`Storage connection was not added: ${safeTerminalText(errorMessage(error))} Retry from Add storage connection.`,
							"error",
						);
					}
				}
				return { kind: "stay" };
			},
			select: async ({ itemId }) => {
				selectedName = nameById.get(itemId);
				return selectedName ? { kind: "to", screen: "detail" } : { kind: "rejected" };
			},
			edit: async ({ state }) => {
				if (!state.selected || state.selected.name !== selectedName) return { kind: "rejected" };
				try {
					await editStorageConnection(
						ctx,
						state.selected.name,
						state.selected.profile,
						state.selected.usedBy,
						signal,
					);
				} catch (error) {
					notifyConnectionError(ctx, state.selected.name, error, signal);
				}
				return { kind: "stay" };
			},
			remove: async ({ state }) => {
				if (!state.selected || state.selected.name !== selectedName) return { kind: "rejected" };
				const name = state.selected.name;
				const confirmed = await ctx.ui.confirm(
					"Remove storage connection?",
					`Remove local storage connection “${safeTerminalText(name)}”? Remote data and history are not deleted.`,
					{ signal },
				);
				if (!confirmed || signal?.aborted) return { kind: "rejected" };
				try {
					await removeStorageConnection(name, signal);
					ctx.ui.notify(`Removed storage connection “${safeTerminalText(name)}”.`, "info");
					selectedName = undefined;
					return { kind: "back" };
				} catch (error) {
					notifyConnectionError(ctx, name, error, signal);
					return { kind: "stay" };
				}
			},
			back: async () => {
				selectedName = undefined;
				return { kind: "back" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => loadStorageMenuState(selectedName, signal),
		signal,
		isCurrent: () => !signal?.aborted,
	});
}

async function loadStorageMenuState(selectedName: string | undefined, signal?: AbortSignal) {
	const raw = await readLocalConfigObject();
	if (signal?.aborted) throw signal.reason;
	const profiles = ownRecord(raw?.storageConnections) ?? {};
	const profile = selectedName ? ownRecord(profiles[selectedName]) : undefined;
	if (!selectedName || !profile) {
		return { version3: raw?.version === 3, profiles, selected: undefined };
	}
	const usedBy = referencingSetups(raw, selectedName);
	return {
		version3: raw?.version === 3,
		profiles,
		selected: {
			name: selectedName,
			profile,
			usedBy,
			lines: [
				`Type: ${connectionType(profile)}`,
				`Endpoint: ${connectionEndpoint(profile)}`,
				`Credentials: ${credentialSource(profile)}`,
				`Used by: ${usedBy.length > 0 ? usedBy.map(safeTerminalText).join(", ") : "No sync setups"}`,
				...(usedBy.length > 0
					? ["Remove unavailable: edit or remove the listed sync setups first."]
					: []),
			],
		},
	};
}

function notifyConnectionError(
	ctx: ExtensionCommandContext,
	name: string,
	error: unknown,
	signal?: AbortSignal,
) {
	if (signal?.aborted) return;
	ctx.ui.notify(
		`Storage connection “${safeTerminalText(name)}” was not changed: ${safeTerminalText(errorMessage(error))} Reopen it and retry.`,
		"error",
	);
}

async function editStorageConnection(
	ctx: ExtensionCommandContext,
	name: string,
	profile: Record<string, unknown>,
	usedBy: string[],
	signal?: AbortSignal,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Editing storage connections requires TUI mode for safe credential handling. Edit the private version 3 settings file instead.",
			"warning",
		);
		return;
	}
	if (profile.type === "webdav") {
		await showEditWebDavStorageProfile(
			ctx,
			name,
			{ ...profile, kind: "webdav", ...(ownRecord(profile.credentials) ?? {}) },
			signal,
			usedBy,
		);
		return;
	}
	if (profile.type === "git") {
		await showEditGitStorageProfile(ctx, name, { ...profile, kind: "git" }, signal, usedBy);
		return;
	}
	const endpoint = await requiredInput(
		ctx,
		"Endpoint",
		String(profile.endpoint ?? "https://s3.example.com"),
		signal,
	);
	if (!endpoint || signal?.aborted) return;
	const region = await requiredInput(ctx, "Region", String(profile.region ?? "auto"), signal);
	if (!region || signal?.aborted) return;
	const storedCredentials = ownRecord(profile.credentials) ?? {};
	const credentials = await chooseS3CredentialUpdate(
		ctx,
		{ ...profile, ...storedCredentials },
		signal,
	);
	if (!credentials || signal?.aborted) return;
	const save = await ctx.ui.select(
		[
			"Review storage connection",
			"",
			`Storage connection: ${safeTerminalText(name)}`,
			`Endpoint: ${safeTerminalText(String(profile.endpoint ?? "missing"))} → ${safeTerminalText(endpoint)}`,
			`Region: ${safeTerminalText(String(profile.region ?? "auto"))} → ${safeTerminalText(region)}`,
			`Credentials: ${safeTerminalText(credentials.summary)}`,
			`Affected sync setups: ${usedBy.length > 0 ? usedBy.map(safeTerminalText).join(", ") : "None"}`,
			"Saving changes future storage access for every affected setup; it does not move remote data.",
		].join("\n"),
		["Save storage connection", "Cancel"],
		{ signal },
	);
	if (save !== "Save storage connection" || signal?.aborted) return;
	await updateStorageConnection(
		name,
		(current) => {
			if (current.type !== "s3") {
				throw new Error("Storage connection type changed; reopen it.");
			}
			return {
				...current,
				endpoint,
				region,
				credentials: applyS3CredentialUpdate(
					current.credentials,
					credentials,
				) as typeof current.credentials,
			};
		},
		usedBy,
		signal,
	);
	if (signal?.aborted) return;
	ctx.ui.notify(`Saved storage connection “${safeTerminalText(name)}”.`, "info");
}

export async function showAddStorageConnection(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Adding storage connections requires TUI mode for safe credential handling. Edit the private version 3 settings file instead.",
			"warning",
		);
		return false;
	}
	const preset = await ctx.ui.select(
		"Storage type",
		["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || !preset || preset === "Cancel") return false;
	if (preset === "WebDAV") return showAddWebDavStorageProfile(ctx, signal);
	if (preset === "Git") return showAddGitStorageProfile(ctx, signal);
	const name = await requiredInput(
		ctx,
		"Name this storage connection",
		preset === "Cloudflare R2" ? "r2" : "s3",
		signal,
	);
	if (!name || signal?.aborted) return false;
	const endpoint = await requiredInput(
		ctx,
		"Endpoint",
		preset === "Cloudflare R2"
			? "https://<account-id>.r2.cloudflarestorage.com"
			: "https://s3.example.com",
		signal,
	);
	if (!endpoint || signal?.aborted) return false;
	const region =
		preset === "Cloudflare R2" ? "auto" : await requiredInput(ctx, "Region", "us-east-1", signal);
	if (!region || signal?.aborted) return false;
	const credentials = await chooseS3Credentials(ctx, signal);
	if (!credentials || signal?.aborted) return false;
	const save = await ctx.ui.select(
		[
			"Review storage connection",
			"",
			`Name: ${safeTerminalText(name)}`,
			`Type: ${preset}`,
			`Endpoint: ${safeTerminalText(endpoint)}`,
			`Region: ${safeTerminalText(region)}`,
			`Credentials: ${safeTerminalText(credentials.summary)}`,
			"Adding a connection does not contact remote storage or start syncing.",
		].join("\n"),
		["Add storage connection", "Cancel"],
		{ signal },
	);
	if (save !== "Add storage connection" || signal?.aborted) return false;
	await addStorageConnection(
		name,
		{
			type: "s3",
			endpoint,
			region,
			credentials: {
				...credentials.profileFields,
				accessKeyId: credentials.profileFields.accessKeyId ?? "",
				secretAccessKey: credentials.profileFields.secretAccessKey ?? "",
			},
		},
		signal,
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(`Added storage connection “${safeTerminalText(name)}”.`, "info");
	return true;
}

function referencingSetups(raw: Record<string, unknown> | undefined, connection: string) {
	return Object.entries(ownRecord(raw?.syncSetups) ?? {})
		.filter(([, value]) => ownRecord(ownRecord(value)?.storage)?.connection === connection)
		.map(([name]) => name)
		.sort((left, right) => left.localeCompare(right));
}

function connectionType(profile: Record<string, unknown>) {
	if (profile.type === "git") return "Git";
	if (profile.type === "webdav") return "WebDAV";
	if (
		profile.type === "s3" &&
		typeof profile.endpoint === "string" &&
		isCloudflareR2Endpoint(profile.endpoint)
	) {
		return "Cloudflare R2";
	}
	return "S3-compatible";
}

function connectionEndpoint(profile: Record<string, unknown>) {
	const value =
		profile.type === "git"
			? profile.remote
			: profile.type === "webdav"
				? profile.url
				: profile.endpoint;
	if (typeof value !== "string" || value.length === 0) return "Missing";
	if (profile.type === "git") return safeTerminalText(value);
	try {
		return safeTerminalText(new URL(value).host);
	} catch {
		return "Invalid";
	}
}

function credentialSource(profile: Record<string, unknown>) {
	if (profile.type === "git") return "Git credential helper or SSH configuration";
	const credentials = ownRecord(profile.credentials);
	if (profile.type === "webdav") return credentials?.password ? "Settings file" : "Missing";
	if (credentials?.accessKeyId && credentials.secretAccessKey) return "Settings file";
	return "Missing";
}
