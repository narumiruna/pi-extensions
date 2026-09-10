import { stripVTControlCharacters } from "node:util";

const MAX_SANITIZER_INPUT_CODE_UNITS = 50_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeChromeDevtoolsDisplay(value: string, maxCharacters = 50_000) {
	const inputWasTruncated = value.length > MAX_SANITIZER_INPUT_CODE_UNITS;
	const boundedInput = inputWasTruncated
		? truncateAtGraphemeBoundary(value, MAX_SANITIZER_INPUT_CODE_UNITS)
		: value;
	const normalizedLineEndings = stripTerminalSequencesLinearly(boundedInput).replace(/\r\n/g, "\n");
	const withoutBidi = stripVTControlCharacters(normalizedLineEndings).replace(
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
	const outputLimit = Math.min(maxCharacters, MAX_SANITIZER_INPUT_CODE_UNITS);
	if (!inputWasTruncated && sanitized.length <= outputLimit) return sanitized;

	return `${truncateAtGraphemeBoundary(sanitized, Math.max(0, outputLimit - 1))}…`;
}

// Pi's parser scans malformed terminal strings repeatedly and recognizes only some CSI finals.
function stripTerminalSequencesLinearly(value: string) {
	const chunks: string[] = [];
	let copiedThrough = 0;
	let position = value.indexOf("\u001b");
	while (position >= 0) {
		const sequenceEnd = terminalSequenceEnd(value, position);
		if (sequenceEnd === -1) {
			chunks.push(value.slice(copiedThrough, position));
			return chunks.join("");
		}
		if (sequenceEnd === undefined) {
			position = value.indexOf("\u001b", position + 1);
			continue;
		}
		chunks.push(value.slice(copiedThrough, position));
		copiedThrough = sequenceEnd;
		position = value.indexOf("\u001b", sequenceEnd);
	}
	chunks.push(value.slice(copiedThrough));
	return chunks.join("");
}

function terminalSequenceEnd(value: string, position: number): number | undefined {
	const type = value[position + 1];
	if (type === "[") {
		for (let index = position + 2; index < value.length; index++) {
			const codeUnit = value.charCodeAt(index);
			if (codeUnit >= 0x40 && codeUnit <= 0x7e) return index + 1;
		}
		return -1;
	}
	if (type !== "]" && type !== "_") return undefined;

	for (let index = position + 2; index < value.length; index++) {
		if (value[index] === "\u0007") return index + 1;
		if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 2;
	}
	return -1;
}

function truncateAtGraphemeBoundary(value: string, maxCodeUnits: number) {
	if (value.length <= maxCodeUnits) return value;
	const boundedLookahead = value.slice(0, Math.max(0, maxCodeUnits) + 2);
	let safeEnd = 0;
	for (const { index, segment } of graphemeSegmenter.segment(boundedLookahead)) {
		const segmentEnd = index + segment.length;
		if (segmentEnd > maxCodeUnits) break;
		safeEnd = segmentEnd;
	}
	return value.slice(0, safeEnd);
}
