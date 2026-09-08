// Fixed messages from https://docs.z.ai/api-reference/api-code. Never interpolate provider text:
// error messages and their template parameters can contain credentials or terminal controls.
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
	"1000": "Authentication failed. Check your API key.",
	"1001": "Authentication header missing. Check your API key.",
	"1003": "Authentication token expired. Obtain a new token.",
	"1005": "Two-factor authentication required.",
	"1113": "Insufficient balance or no resource package. Recharge your account.",
	"1200": "API call error. Try again later.",
	"1210": "Invalid API parameter. Check the API documentation.",
	"1211": "Unknown model. Check the model ID.",
	"1212": "This model does not support the requested method.",
	"1213": "A required parameter is missing.",
	"1214": "Invalid parameter. Check the API documentation.",
	"1215": "Conflicting parameters. Check the API documentation.",
	"1220": "Access denied. Check your permissions.",
	"1221": "This API has been taken offline.",
	"1222": "This API does not exist.",
	"1230": "API processing error. Try again later.",
	"1234": "Network error. Try again later.",
	"1261": "Prompt too long. Reduce the input length.",
	"1301": "Content rejected by the safety policy.",
	"1302": "Request rate limit reached. Try again later.",
	"1305": "Service overloaded. Try again later.",
	"1308": "Usage limit reached. Wait for the quota reset.",
	"1309": "GLM Coding Plan expired. Renew your subscription.",
	"1310": "Weekly or monthly limit exhausted. Wait for the quota reset.",
	"1311": "Your subscription does not include this model.",
	"1313": "Request frequency restricted by the Fair Usage Policy. Contact support.",
	"1314": "Enterprise package expired. Contact your administrator.",
	"1315": "This API key requires an enterprise coding package scenario. Replace the key.",
	"1316": "5-hour limit reached; insufficient balance for extra usage. Wait for reset.",
	"1317": "7-day limit reached; insufficient balance for extra usage. Wait for reset.",
	"1318": "5-hour limit reached; extra usage blocked by monthly spend limit.",
	"1319": "7-day limit reached; extra usage blocked by monthly spend limit.",
	"1320": "5-hour limit reached; extra usage blocked by monthly spend limit.",
	"1321": "7-day limit reached; extra usage blocked by monthly spend limit.",
};

const HTTP_MESSAGES: Readonly<Record<number, string>> = {
	400: "Invalid request. Check the API documentation.",
	401: "Authentication failed. Check your API key.",
	403: "Access denied. Check your permissions.",
	429: "Request or usage limit reached. Try again later.",
	500: "Internal error. Try again later.",
};

export function zaiPayloadError(payload: unknown): string | undefined {
	const object = asObject(payload);
	if (!object) return undefined;
	const nested = asObject(object.error);
	const rawCode = nested ? nested.code : object.code;
	const code = errorCode(rawCode);
	if (
		object.error === undefined &&
		object.success !== false &&
		(rawCode === undefined || code === "0" || code === "200")
	) {
		return undefined;
	}
	return code && code !== "0" && code !== "200"
		? `Z.AI ${code}: ${ERROR_MESSAGES[code] ?? "API request failed."}`
		: "Z.AI: API request failed.";
}

export function zaiResponseError(status: number, text: string): string | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(text) as unknown;
	} catch {
		// Do not expose JSON parser excerpts, response bodies, or statusText.
		if (status >= 200 && status < 300) return "Z.AI: Invalid JSON response.";
	}
	const error = zaiPayloadError(payload);
	if (error) return error;
	if (status < 200 || status >= 300) {
		return `Z.AI HTTP ${status}: ${HTTP_MESSAGES[status] ?? "API request failed."}`;
	}
	return undefined;
}

function errorCode(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999) {
		return String(value);
	}
	return typeof value === "string" && /^(?:0|[1-9]\d{0,3})$/u.test(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
