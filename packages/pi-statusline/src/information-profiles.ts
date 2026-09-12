import type { ConfigSegmentName, SegmentName } from "./types.js";

export const INFORMATION_PROFILE_NAMES = ["minimal", "balanced", "detailed"] as const;
export type InformationProfileName = (typeof INFORMATION_PROFILE_NAMES)[number];
export type InformationProfile = InformationProfileName | "custom";

/** Per-profile column layout: `rightSegments` renders flush against the right edge. */
export interface InformationProfileLayout {
  left: SegmentName[];
  right: SegmentName[];
}

export const INFORMATION_PROFILES: Readonly<Record<InformationProfileName, InformationProfileLayout>> = {
  minimal: { left: ["cwd", "branch", "context"], right: ["model"] },
  balanced: {
    left: ["thinking", "cwd", "branch", "tools", "context", "time"],
    right: ["session", "provider", "model"],
  },
  detailed: {
    left: ["thinking", "cwd", "branch", "tools", "context", "tokens", "cache", "cost", "time"],
    right: ["session", "provider", "model"],
  },
};

export function inferInformationProfile(config: {
  segments: readonly ConfigSegmentName[];
  rightSegments: readonly ConfigSegmentName[];
}): InformationProfile {
  for (const name of INFORMATION_PROFILE_NAMES) {
    const profile = INFORMATION_PROFILES[name];
    if (columnsEqual(config.segments, profile.left) && columnsEqual(config.rightSegments, profile.right)) {
      return name;
    }
  }
  return "custom";
}

function columnsEqual(actual: readonly ConfigSegmentName[], expected: readonly SegmentName[]): boolean {
  return actual.length === expected.length && actual.every((segment, index) => segment === expected[index]);
}
