import type { AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";
import { abortError } from "./remote-types.js";

export async function collectProviderUsage(
	stream: AssistantMessageEventStream,
	signal: AbortSignal,
): Promise<Usage> {
	let usage: Usage | undefined;
	for await (const event of stream) {
		if (signal.aborted) throw abortError();
		if (event.type === "error") {
			throw new Error(event.error.errorMessage ?? "Responses compaction request failed");
		}
		if (event.type === "done") usage = event.message.usage;
	}
	if (signal.aborted) throw abortError();
	if (!usage) throw new Error("Responses provider stream ended without completion usage");
	return usage;
}
