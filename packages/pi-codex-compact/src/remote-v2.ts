import {
	CodexCompactionProtocolError,
	type CollectedCompaction,
	collectCompactionSse,
	prepareRemoteCompactionPayload,
} from "./protocol.js";
import { collectProviderUsage } from "./remote-shared.js";
import {
	abortError,
	assertPreparedInput,
	type RemoteCompactionRequest,
	type RemoteCompactionResponse,
} from "./remote-types.js";

export async function requestRemoteCompactionV2(
	request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
	if (request.signal.aborted) throw abortError();
	let sentInput: ReturnType<typeof assertPreparedInput> | undefined;
	const inspections: Promise<
		{ ok: true; value: CollectedCompaction } | { ok: false; error: unknown }
	>[] = [];
	const baseFetch = request.fetch ?? globalThis.fetch;
	const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
		const response = await baseFetch(input, init);
		if (!response.ok || !response.body) return response;
		const [providerBody, inspectionBody] = response.body.tee();
		const inspection = collectCompactionSse(inspectionBody, { signal: request.signal }).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		inspections.push(inspection);
		return new Response(providerBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};

	const stream = request.provider.stream(request.model, request.context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		transport: "sse",
		cacheRetention: "none",
		timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
		maxRetries: request.maxRetries ?? 2,
		fetch: inspectedFetch,
		onPayload: (payload) => {
			const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);
			sentInput = assertPreparedInput(prepared).slice(0, -1);
			return prepared;
		},
	});

	const usage = await collectProviderUsage(stream, request.signal);
	if (!sentInput) {
		throw new CodexCompactionProtocolError("Provider did not expose a request payload");
	}
	if (inspections.length !== 1) {
		throw new CodexCompactionProtocolError(
			`Provider exposed ${inspections.length} successful SSE responses; expected exactly one`,
		);
	}
	const inspection = await inspections[0];
	if (request.signal.aborted) throw abortError();
	if (!inspection.ok) throw inspection.error;
	return { item: inspection.value.item, promptInput: sentInput, usage };
}
