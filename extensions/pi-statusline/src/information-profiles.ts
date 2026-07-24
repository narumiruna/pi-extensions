import type { ConfigSegmentName, SegmentName } from "./types.js";

export const INFORMATION_PROFILE_NAMES = ["minimal", "balanced", "detailed"] as const;
export type InformationProfileName = (typeof INFORMATION_PROFILE_NAMES)[number];
export type InformationProfile = InformationProfileName | "custom";

export const INFORMATION_PROFILES: Readonly<
	Record<InformationProfileName, readonly SegmentName[]>
> = {
	minimal: ["model", "cwd", "branch", "context"],
	balanced: ["model", "thinking", "cwd", "branch", "tools", "context", "cost"],
	detailed: [
		"provider",
		"model",
		"thinking",
		"cwd",
		"branch",
		"tools",
		"context",
		"tokens",
		"cost",
		"time",
	],
};

export function inferInformationProfile(
	segments: readonly ConfigSegmentName[],
): InformationProfile {
	for (const name of INFORMATION_PROFILE_NAMES) {
		const profile = INFORMATION_PROFILES[name];
		if (
			segments.length === profile.length &&
			segments.every((segment, index) => segment === profile[index])
		) {
			return name;
		}
	}
	return "custom";
}
