import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function sanitizeDiagnosticText(value: string, maximumLength = 512): string {
	const safeCharacters = [...stripTerminalSequences(value)].filter((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return !isForbiddenCodePoint(codePoint);
	});
	const sanitized = safeCharacters.join("").split(/\s+/u).filter(Boolean).join(" ");
	if (sanitized.length <= maximumLength) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function isForbiddenCodePoint(codePoint: number): boolean {
	return (
		codePoint <= 8 ||
		(codePoint >= 11 && codePoint <= 12) ||
		(codePoint >= 14 && codePoint <= 31) ||
		(codePoint >= 127 && codePoint <= 159) ||
		codePoint === 0x061c ||
		(codePoint >= 0x200e && codePoint <= 0x200f) ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}
