import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptSecret } from "./secret-input.js";

export interface ChosenS3Credentials {
	profileFields: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
	summary: string;
	ready: boolean;
	replace?: boolean;
}

export async function chooseS3CredentialUpdate(
	ctx: ExtensionCommandContext,
	profile: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const hasStored =
		typeof profile.accessKeyId === "string" && typeof profile.secretAccessKey === "string";
	if (hasStored) {
		const action = await ctx.ui.select(
			"Credentials",
			["Keep current credentials", "Change credential source", "Cancel"],
			{ signal },
		);
		throwIfAborted(signal);
		if (!action || action === "Cancel") return undefined;
		if (action === "Keep current credentials") {
			return { profileFields: {}, summary: "Unchanged (values hidden)", ready: true };
		}
	}
	const selected = await chooseS3Credentials(ctx, signal);
	return selected ? { ...selected, replace: true } : undefined;
}

export function applyS3CredentialUpdate(
	profile: Record<string, unknown>,
	credentials: ChosenS3Credentials,
) {
	const next = { ...profile };
	if (credentials.replace) {
		delete next.accessKeyId;
		delete next.secretAccessKey;
		delete next.sessionToken;
	}
	return { ...next, ...credentials.profileFields };
}

export async function chooseS3Credentials(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
): Promise<ChosenS3Credentials | undefined> {
	const choice = await ctx.ui.select(
		"Credentials\n\nCredentials are stored in the private pi-sync settings file. Secret values are masked during input and never shown afterward.",
		["Store credentials privately", "Store temporary credentials privately", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	const temporary = choice === "Store temporary credentials privately";
	if (choice !== "Store credentials privately" && !temporary) return undefined;
	const accessKeyId = await requiredCredentialInput(ctx, "Access key ID", "access-key-id", signal);
	if (!accessKeyId) return undefined;
	const secretAccessKey = await promptSecret(ctx, "Secret access key", { signal });
	throwIfAborted(signal);
	if (secretAccessKey === undefined) return undefined;
	let sessionToken: string | undefined;
	if (temporary) {
		sessionToken = await promptSecret(ctx, "Session token", { signal });
		throwIfAborted(signal);
		if (sessionToken === undefined) return undefined;
	}
	return {
		profileFields: { accessKeyId, secretAccessKey, ...(temporary ? { sessionToken } : {}) },
		summary: temporary
			? "Stored privately with session token (values hidden)"
			: "Stored privately (values hidden)",
		ready: true,
	};
}

async function requiredCredentialInput(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
	signal?: AbortSignal,
) {
	const value = await ctx.ui.input(title, placeholder, { signal });
	throwIfAborted(signal);
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) {
		ctx.ui.notify(`${title} is required.`, "warning");
		return undefined;
	}
	return normalized.includes("<") || normalized.includes(">") ? undefined : normalized;
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}
