export function terminalText(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
	}).join("");
}
