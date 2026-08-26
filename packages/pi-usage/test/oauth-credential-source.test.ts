import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	collectOAuthCredentialCandidates,
	createOAuthCredentialCandidateReader,
	OAUTH_CREDENTIAL_SOURCE_CHANNEL,
} from "../src/oauth-credential-source.js";

const credential = (suffix: string) => ({
	type: "oauth" as const,
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: 1_000,
	metadata: { value: suffix },
});

test("credential candidate reader preserves standalone fallback with no listener", () => {
	const mock = createMockPi();
	const { ctx } = createMockContext();
	const reader = createOAuthCredentialCandidateReader(mock.pi, () => credential("fallback"));

	assert.deepEqual(reader(ctx, "github-copilot"), {
		ok: true,
		candidates: [credential("fallback")],
		offeredCount: 0,
	});
});

test("credential candidate reader collects only synchronous relevant offers without caching", () => {
	const mock = createMockPi();
	const session = {};
	const { ctx } = createMockContext({ sessionManager: session });
	let requests = 0;
	let lateOffer: ((candidate: unknown) => void) | undefined;
	const source = credential("source");
	mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
		requests += 1;
		const request = data as {
			session: object;
			provider: string;
			offer(candidate: unknown): void;
		};
		if (request.session !== session || request.provider !== "github-copilot") return;
		lateOffer = request.offer;
		request.offer(source);
		request.offer(null);
		request.offer({ type: "oauth", access: "incomplete" });
	});
	mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, () => {
		throw new Error("one listener failed");
	});
	const reader = createOAuthCredentialCandidateReader(mock.pi, () => undefined);

	const first = reader(ctx, "github-copilot");
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.candidates.length, 1);
	lateOffer?.(credential("after-return"));
	assert.equal(first.candidates.length, 1);
	assert.equal(first.candidates[0]?.access, "access-source");
	(first.candidates[0] as unknown as { metadata: { value: string } }).metadata.value =
		"caller-mutated";
	const second = reader(ctx, "github-copilot");
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(
		(second.candidates[0] as unknown as { metadata: { value: string } }).metadata.value,
		"source",
	);
	assert.equal(requests, 2);
});

test("credential candidate reader includes protocol and fallback candidates for deterministic selection", () => {
	const mock = createMockPi();
	const { ctx } = createMockContext();
	mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
		(data as { offer(candidate: unknown): void }).offer(credential("source"));
	});

	const result = collectOAuthCredentialCandidates(mock.rawPi, ctx, "openai-codex", () =>
		credential("fallback"),
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(
		result.candidates.map((candidate) => candidate.access),
		["access-source", "access-fallback"],
	);
});

test("credential candidate reader fails closed when event emission fails", () => {
	const { ctx } = createMockContext();
	const result = collectOAuthCredentialCandidates(
		{
			events: {
				emit() {
					throw new Error("event bus unavailable");
				},
				on() {
					return () => undefined;
				},
			},
		} as never,
		ctx,
		"github-copilot",
		() => credential("fallback"),
	);
	assert.deepEqual(result, { ok: false });
});
