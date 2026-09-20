import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const OAUTH_CREDENTIAL_SOURCE_CHANNEL = "oauth:credential-source:v1";
export const OAUTH_CREDENTIAL_READINESS_CHANNEL = "oauth:credential-readiness:v1";

export type OAuthCredentialSourceRequest = {
  session: object;
  provider: string;
  offer: (credential: OAuthCredential) => void;
};

export type OAuthCredentialReadinessRequest = {
  session: object;
  provider: string;
  waitUntil: (pending: Promise<unknown>) => void;
};

export type OAuthCredentialSource = {
  offerCredential(data: unknown): void;
};

export type OAuthCredentialReadinessSource = {
  waitForCredential(data: unknown): void;
};

export function registerOAuthCredentialSource(pi: ExtensionAPI, sources: Iterable<OAuthCredentialSource>): void {
  pi.events.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
    for (const source of sources) source.offerCredential(data);
  });
}

export function registerOAuthCredentialReadiness(
  pi: ExtensionAPI,
  sources: Iterable<OAuthCredentialReadinessSource>,
): void {
  pi.events.on(OAUTH_CREDENTIAL_READINESS_CHANNEL, (data) => {
    for (const source of sources) source.waitForCredential(data);
  });
}

export function parseCredentialRequest(data: unknown): OAuthCredentialSourceRequest | undefined {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const request = data as Partial<OAuthCredentialSourceRequest>;
    if (!request.session || typeof request.session !== "object") return undefined;
    if (typeof request.provider !== "string" || !request.provider) return undefined;
    if (typeof request.offer !== "function") return undefined;
    return request as OAuthCredentialSourceRequest;
  } catch {
    return undefined;
  }
}

export function parseCredentialReadinessRequest(data: unknown): OAuthCredentialReadinessRequest | undefined {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const request = data as Partial<OAuthCredentialReadinessRequest>;
    if (!request.session || typeof request.session !== "object") return undefined;
    if (typeof request.provider !== "string" || !request.provider) return undefined;
    if (typeof request.waitUntil !== "function") return undefined;
    return request as OAuthCredentialReadinessRequest;
  } catch {
    return undefined;
  }
}

export function cloneOAuthCredential(credential: OAuthCredential): OAuthCredential | undefined {
  try {
    const clone = structuredClone(credential) as OAuthCredential;
    if (!clone || typeof clone !== "object" || Array.isArray(clone)) return undefined;
    if (clone.type !== "oauth") return undefined;
    if (typeof clone.access !== "string" || !clone.access) return undefined;
    if (typeof clone.refresh !== "string") return undefined;
    if (typeof clone.expires !== "number" || !Number.isFinite(clone.expires)) return undefined;
    return clone;
  } catch {
    return undefined;
  }
}
