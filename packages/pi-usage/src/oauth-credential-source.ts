import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";

export const OAUTH_CREDENTIAL_SOURCE_CHANNEL = "oauth:credential-source:v1";

export type StoredCredentialReader = (providerId: string) => unknown;

export type OAuthCredentialCandidates =
	| { ok: true; candidates: readonly OAuthCredential[]; offeredCount?: number }
	| { ok: false };

export type OAuthCredentialCandidateReader = (
	ctx: ExtensionContext,
	providerId: string,
) => OAuthCredentialCandidates;

export function createOAuthCredentialCandidateReader(
	pi: ExtensionAPI,
	credentialReader: StoredCredentialReader = readStoredCredential,
): OAuthCredentialCandidateReader {
	return (ctx, providerId) =>
		collectOAuthCredentialCandidates(pi, ctx, providerId, credentialReader);
}

export function collectOAuthCredentialCandidates(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	providerId: string,
	credentialReader: StoredCredentialReader = readStoredCredential,
): OAuthCredentialCandidates {
	const candidates: OAuthCredential[] = [];
	let collecting = true;
	const request = Object.freeze({
		session: ctx.sessionManager,
		provider: providerId,
		offer(candidate: unknown) {
			if (!collecting) return;
			const clone = cloneOAuthCredential(candidate);
			if (clone) candidates.push(clone);
		},
	});
	try {
		pi.events.emit(OAUTH_CREDENTIAL_SOURCE_CHANNEL, request);
	} catch {
		return { ok: false };
	} finally {
		collecting = false;
	}
	const offeredCount = candidates.length;
	try {
		const fallback = cloneOAuthCredential(credentialReader(providerId));
		if (fallback) candidates.push(fallback);
	} catch {
		// A malformed or unavailable standalone credential is equivalent to no fallback.
	}
	return { ok: true, candidates, offeredCount };
}

export function fallbackOAuthCredentialCandidates(
	providerId: string,
	credentialReader: StoredCredentialReader,
): OAuthCredentialCandidates {
	try {
		const credential = cloneOAuthCredential(credentialReader(providerId));
		return { ok: true, candidates: credential ? [credential] : [], offeredCount: 0 };
	} catch {
		return { ok: true, candidates: [], offeredCount: 0 };
	}
}

function cloneOAuthCredential(value: unknown): OAuthCredential | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const clone = structuredClone(value) as OAuthCredential;
		if (!clone || typeof clone !== "object" || Array.isArray(clone)) return undefined;
		if (clone.type !== "oauth") return undefined;
		if (typeof clone.access !== "string" || !clone.access) return undefined;
		if (typeof clone.refresh !== "string" || !clone.refresh) return undefined;
		if (typeof clone.expires !== "number" || !Number.isFinite(clone.expires)) return undefined;
		return clone;
	} catch {
		return undefined;
	}
}
