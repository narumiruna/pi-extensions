import { requestResponsesCompact } from "./remote-compact.js";
import type { RemoteCompactionRequest, RemoteCompactionResponse } from "./remote-types.js";
import { requestRemoteCompactionV2 } from "./remote-v2.js";

export type {
	PriorCheckpointPayload,
	RemoteCompactionRequest,
	RemoteCompactionResponse,
} from "./remote-types.js";

export function requestRemoteCompaction(
	request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
	return request.protocol === "responses-compact"
		? requestResponsesCompact(request)
		: requestRemoteCompactionV2(request);
}
