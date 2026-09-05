import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

const MAX_ERROR_LENGTH = 1000;
const MAX_ERROR_SOURCE_LENGTH = 8000;
const MAX_DISPLAY_VALUE_LENGTH = 500;

export function formatError(error) {
	const raw = error instanceof Error ? error.message : String(error);
	return sanitizeAndBound(raw, MAX_ERROR_LENGTH, MAX_ERROR_SOURCE_LENGTH);
}

export function formatDisplayValue(value) {
	return JSON.stringify(sanitizeAndBound(String(value), MAX_DISPLAY_VALUE_LENGTH, 4000));
}

function sanitizeAndBound(value, maximumLength, maximumSourceLength) {
	const result = sanitizeTerminalText(value.slice(0, maximumSourceLength));
	const truncated = value.length > maximumSourceLength || result.length > maximumLength;
	return truncated ? `${result.slice(0, Math.max(0, maximumLength - 1))}…` : result;
}
