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
		return unsafeControl ? "�" : character;
	}).join("");
	if (sanitized.length <= maxCharacters) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}
