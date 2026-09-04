export function sanitizeSingleLine(text: string): string {
	return [...text.replace(/[\r\n\t]/gu, " ")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ +/gu, " ")
		.trim();
}

export function formatKeyLabel(key: string): string {
	const sanitized = sanitizeSingleLine(key);
	if (!sanitized) return "";
	return sanitized
		.split("+")
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "shift") return "Shift";
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "super") return "Super";
			return part.length === 1
				? part.toUpperCase()
				: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
		})
		.join("+");
}
