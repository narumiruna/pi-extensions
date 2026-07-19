import { telegraphRequest } from "./client.js";
import {
	loadTelegraphConfig,
	type TelegraphConfig,
	withTelegraphConfigLock,
	writeTelegraphConfig,
} from "./config.js";

export interface ResolvedTelegraphAccount {
	config: TelegraphConfig;
	accountCreated: boolean;
}

export async function ensureTelegraphAccount(
	signal?: AbortSignal,
): Promise<ResolvedTelegraphAccount> {
	return withTelegraphConfigLock(signal, async () => {
		const loaded = await loadTelegraphConfig();
		if (loaded.config.accessToken) {
			return { config: loaded.config, accountCreated: false };
		}

		const result = await telegraphRequest(
			"createAccount",
			undefined,
			{
				short_name: loaded.config.shortName,
				author_name: loaded.config.authorName,
				author_url: loaded.config.authorUrl,
			},
			signal,
		);
		if (!isPlainObject(result) || typeof result.access_token !== "string" || !result.access_token) {
			throw new Error("Telegraph createAccount returned no access token.");
		}
		const config: TelegraphConfig = {
			...loaded.config,
			accessToken: result.access_token,
		};
		await writeTelegraphConfig(config);
		return { config, accountCreated: true };
	});
}

export async function requireTelegraphAccessToken() {
	const loaded = await loadTelegraphConfig();
	if (!loaded.config.accessToken) {
		throw new Error(
			`Telegraph editing requires an accessToken in ${loaded.path}. Run /telegraph init to create the private config, then import the page owner's token.`,
		);
	}
	return { config: loaded.config, accessToken: loaded.config.accessToken };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
