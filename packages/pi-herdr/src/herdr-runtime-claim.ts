import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "pi-herdr:runtime-claim:v1";

/** Avoid duplicate reporters when Pi discovers both source and generated copies of this package. */
export function claimHerdrRuntime(pi: ExtensionAPI): (() => void) | undefined {
  const request = { version: 1, claimed: false };
  // Pi's public event bus dispatches synchronous handlers before emit returns.
  pi.events.emit(CHANNEL, request);
  if (request.claimed) return undefined;
  return pi.events.on(CHANNEL, (value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "claimed" in value &&
      typeof value.claimed === "boolean"
    )
      value.claimed = true;
  });
}
