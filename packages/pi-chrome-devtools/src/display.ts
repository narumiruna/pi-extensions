import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function sanitizeChromeDevtoolsDisplay(value: string, maxCharacters = 50_000) {
	const withoutBidi = stripVTControlCharacters(stripTerminalSequences(value)).replace(
		/[\u202a-\u202e\u2066-\u2069]/gu,
		"�",
	);
	const sanitized = Array.from(withoutBidi, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafeControl =
			(codePoint >= 0 && codePoint <= 8) ||
			(codePoint >= 11 && codePoint <= 31) ||
			(codePoint >= 127 && codePoint <= 159);
		const loneSurrogate = character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff;
		return unsafeControl || loneSurrogate ? "�" : character;
	}).join("");
	if (sanitized.length <= maxCharacters) return sanitized;

	let truncated = sanitized.slice(0, Math.max(0, maxCharacters - 1));
	const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1);
	return `${truncated}…`;
}
