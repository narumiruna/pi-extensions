import assert from "node:assert/strict";
import { test } from "vitest";
import { zaiPayloadError, zaiResponseError } from "../src/providers/zai-errors.js";

// Inventory the business codes documented at https://docs.z.ai/api-reference/api-code.
const documented = [
	[1000, /Authentication failed/],
	[1001, /Authentication header missing/],
	[1003, /token expired/],
	[1005, /Two-factor/],
	[1113, /Insufficient balance or no resource package/],
	[1200, /API call error/],
	[1210, /Invalid API parameter/],
	[1211, /Unknown model/],
	[1212, /does not support the requested method/],
	[1213, /required parameter is missing/],
	[1214, /Invalid parameter/],
	[1215, /Conflicting parameters/],
	[1220, /Access denied/],
	[1221, /taken offline/],
	[1222, /does not exist/],
	[1230, /API processing error/],
	[1234, /Network error/],
	[1261, /Prompt too long/],
	[1301, /safety policy/],
	[1302, /Request rate limit/],
	[1305, /Service overloaded/],
	[1308, /Usage limit reached/],
	[1309, /GLM Coding Plan expired/],
	[1310, /Weekly or monthly limit/],
	[1311, /subscription does not include this model/],
	[1313, /Fair Usage Policy/],
	[1314, /Enterprise package expired/],
	[1315, /enterprise coding package scenario/],
	[1316, /5-hour limit reached; insufficient balance/],
	[1317, /7-day limit reached; insufficient balance/],
	[1318, /5-hour limit reached; extra usage blocked by monthly spend limit/],
	[1319, /7-day limit reached; extra usage blocked by monthly spend limit/],
	[1320, /5-hour limit reached; extra usage blocked by monthly spend limit/],
	[1321, /7-day limit reached; extra usage blocked by monthly spend limit/],
] as const;

test("every documented Z.AI business code has a fixed message in both response shapes", () => {
	for (const [code, expected] of documented) {
		for (const value of [code, String(code)]) {
			for (const payload of [
				{ error: { code: value, message: "untrusted" } },
				{ code: value, success: false, msg: "untrusted" },
			]) {
				const message = zaiPayloadError(payload);
				assert.ok(message);
				assert.ok(message.startsWith(`Z.AI ${code}: `));
				assert.match(message, expected);
				assert.doesNotMatch(message, /untrusted/);
			}
		}
	}
});

test("Z.AI errors do not depend on message text or replace quota success", () => {
	for (const msg of [undefined, "", "任意訊息", "No subscription", "\u001b[31msecret"]) {
		assert.equal(zaiPayloadError({ msg, data: {} }), undefined);
		for (const code of [0, "0", 200, "200"]) {
			assert.equal(zaiPayloadError({ code, success: true, msg, data: {} }), undefined);
		}
		assert.equal(
			zaiPayloadError({ code: 500, msg, success: false }),
			"Z.AI 500: API request failed.",
		);
	}
});

test("Z.AI handles unknown, malformed, and conflicting codes without echoing raw values", () => {
	assert.equal(zaiPayloadError({ error: { code: "9999" } }), "Z.AI 9999: API request failed.");
	for (const code of [undefined, null, {}, [], true, -1, 1.5, 10000, "01309", "1309secret"]) {
		assert.equal(zaiPayloadError({ error: { code } }), "Z.AI: API request failed.");
		assert.equal(zaiPayloadError({ code, success: false }), "Z.AI: API request failed.");
	}
	for (const error of [null, [], "secret", {}, { code: "0" }, { code: "200" }]) {
		assert.equal(zaiPayloadError({ error }), "Z.AI: API request failed.");
	}
	assert.match(zaiPayloadError({ code: 500, error: { code: "1309" } }) ?? "", /1309: .*expired/);
	for (const payload of [null, [], "secret", false]) {
		assert.equal(zaiPayloadError(payload), undefined);
	}
});

test("Z.AI uses HTTP fallbacks only when no business error is available", () => {
	for (const [status, expected] of [
		[400, /Invalid request/],
		[401, /Authentication failed/],
		[403, /Access denied/],
		[429, /Request or usage limit/],
		[500, /Internal error/],
		[503, /API request failed/],
	] as const) {
		for (const text of ["secret", "{}", "null", "[]", '{"code":200}']) {
			const error = zaiResponseError(status, text);
			assert.ok(error);
			assert.ok(error.startsWith(`Z.AI HTTP ${status}: `));
			assert.match(error, expected);
			assert.doesNotMatch(error, /secret/);
		}
		assert.match(
			zaiResponseError(status, '{"error":{"code":"1113"}}') ?? "",
			/1113: Insufficient balance or no resource package/,
		);
	}
	assert.equal(zaiResponseError(200, "secret"), "Z.AI: Invalid JSON response.");
	assert.equal(zaiResponseError(200, '{"code":200,"data":{}}'), undefined);
	assert.match(zaiResponseError(200, '{"error":{"code":"1309"}}') ?? "", /1309: .*expired/);
});
