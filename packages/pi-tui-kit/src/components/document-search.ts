import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type Focusable,
	Input,
	Key,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "../terminal-document.js";
import type { MenuBinding, MenuKeybindings } from "./contracts.js";
import { handleSearchInput } from "./rendering.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const MAX_HIGHLIGHTED_MATCHES = 1_000;
const MAX_SEARCH_QUERY_LENGTH = 4_096;
const MAX_PASTE_BUFFER_LENGTH = MAX_SEARCH_QUERY_LENGTH * 16;
const DOCUMENT_SEARCH_CONFLICT_BINDINGS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.cancel",
	"tui.altScreen.search",
] as const satisfies readonly MenuBinding[];
const DOCUMENT_SEARCH_ACTIVE_ACTION_BINDINGS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.altScreen.searchNext",
	"tui.altScreen.searchPrevious",
	"tui.altScreen.searchClose",
] as const satisfies readonly MenuBinding[];
export const DOCUMENT_SEARCH_ACTIVATE_KEY = Key.space;

export function documentSearchActivationAvailable(
	keybindings: MenuKeybindings,
	includeConfirm: boolean,
) {
	return ![
		...DOCUMENT_SEARCH_CONFLICT_BINDINGS,
		...(includeConfirm ? (["tui.select.confirm"] as const) : []),
	].some((binding) => keybindings.matches(" ", binding));
}

export function documentSearchActionMatches(keybindings: MenuKeybindings, data: string) {
	return DOCUMENT_SEARCH_ACTIVE_ACTION_BINDINGS.some((binding) =>
		keybindings.matches(data, binding),
	);
}

type SearchTheme = Pick<Theme, "bold" | "fg"> &
	Partial<Pick<Theme, "bg" | "inverse" | "underline">>;

interface CellRange {
	row: number;
	start: number;
	end: number;
}

interface DocumentMatch {
	ranges: CellRange[];
}

interface CorpusCells {
	rows: Uint32Array;
	starts: Uint32Array;
	ends: Uint32Array;
}

interface CompactMatchGroup {
	cells: CorpusCells;
	offsets: Uint32Array;
}

const INVALID_CELL = 0xffffffff;

class CorpusCellBuilder {
	private rows: Uint32Array;
	private starts: Uint32Array;
	private ends: Uint32Array;
	private length = 0;

	constructor(initialCapacity = 1_024) {
		const capacity = Math.max(1, initialCapacity);
		this.rows = new Uint32Array(capacity);
		this.starts = new Uint32Array(capacity);
		this.ends = new Uint32Array(capacity);
	}

	push(row: number, start: number, end: number) {
		this.ensureCapacity();
		this.rows[this.length] = row;
		this.starts[this.length] = start;
		this.ends[this.length] = end;
		this.length += 1;
	}

	finish(): CorpusCells {
		if (this.length === this.rows.length) {
			return { rows: this.rows, starts: this.starts, ends: this.ends };
		}
		return {
			rows: this.rows.slice(0, this.length),
			starts: this.starts.slice(0, this.length),
			ends: this.ends.slice(0, this.length),
		};
	}

	private ensureCapacity() {
		if (this.length < this.rows.length) return;
		const capacity = this.rows.length * 2;
		const rows = new Uint32Array(capacity);
		const starts = new Uint32Array(capacity);
		const ends = new Uint32Array(capacity);
		rows.set(this.rows);
		starts.set(this.starts);
		ends.set(this.ends);
		this.rows = rows;
		this.starts = starts;
		this.ends = ends;
	}
}

class MatchOffsetBuilder {
	private offsets: Uint32Array;
	private length = 0;

	constructor(initialCapacity = 1_024) {
		this.offsets = new Uint32Array(Math.max(2, initialCapacity));
	}

	push(start: number, end: number) {
		if (this.length + 2 > this.offsets.length) {
			const offsets = new Uint32Array(this.offsets.length * 2);
			offsets.set(this.offsets);
			this.offsets = offsets;
		}
		this.offsets[this.length] = start;
		this.offsets[this.length + 1] = end;
		this.length += 2;
	}

	finish() {
		return this.length === this.offsets.length ? this.offsets : this.offsets.slice(0, this.length);
	}
}

function emptyCorpusCells(): CorpusCells {
	return {
		rows: new Uint32Array(),
		starts: new Uint32Array(),
		ends: new Uint32Array(),
	};
}

export interface DocumentSearchSegment {
	row: number;
	column: number;
	text: string;
	separatorBefore?: boolean;
}

export type DocumentSearchSource = readonly DocumentSearchSegment[];

export class DocumentSearchController implements Focusable {
	private inputComponent = new Input();
	active = false;
	private parentFocused = false;
	private lines: readonly string[] = [];
	private softWrapAfter: readonly boolean[] = [];
	private ignoreLeadingWhitespace: readonly boolean[] = [];
	private searchSources: readonly DocumentSearchSource[] = [];
	private corpus = "";
	private cells = emptyCorpusCells();
	private corpusReady = false;
	private compactMatchOffsets: Uint32Array | undefined;
	private compactMatchGroups: CompactMatchGroup[] = [];
	private compactMatchGroupIndexes = new Uint32Array();
	private compactMatchIndexes = new Uint32Array();
	private currentIndex = 0;
	private pasting = false;
	private pasteBuffer = "";
	private pasteStartBuffer = "";
	private anchorRow = 0;

	get input() {
		return this.inputComponent;
	}

	get focused() {
		return this.parentFocused;
	}

	set focused(value: boolean) {
		this.parentFocused = value;
		this.syncFocus();
	}

	get count() {
		if (this.compactMatchGroups.length === 1) {
			return (this.compactMatchGroups[0]?.offsets.length ?? 0) / 2;
		}
		return this.compactMatchGroupIndexes.length;
	}

	get current() {
		return this.count === 0 ? 0 : this.currentIndex + 1;
	}

	get currentRow() {
		return this.currentMatch()?.ranges[0]?.row;
	}

	activate(
		lines: readonly string[],
		softWrapAfter: readonly boolean[] = [],
		ignoreLeadingWhitespace: readonly boolean[] = [],
		searchSources: readonly DocumentSearchSource[] = [],
		anchorRow = 0,
	) {
		this.active = true;
		this.anchorRow = Math.max(0, anchorRow);
		this.updateLines(lines, softWrapAfter, ignoreLeadingWhitespace, searchSources);
		this.ensureCorpus();
		this.syncFocus();
	}

	close() {
		this.active = false;
		this.input.focused = false;
		this.inputComponent = new Input();
		this.releaseCorpus();
		this.currentIndex = 0;
		this.anchorRow = 0;
		this.pasting = false;
		this.pasteBuffer = "";
		this.pasteStartBuffer = "";
		this.syncFocus();
	}

	updateLines(
		lines: readonly string[],
		softWrapAfter: readonly boolean[] = [],
		ignoreLeadingWhitespace: readonly boolean[] = [],
		searchSources: readonly DocumentSearchSource[] = [],
	) {
		if (
			sameLines(this.lines, lines) &&
			sameValues(this.softWrapAfter, softWrapAfter) &&
			sameValues(this.ignoreLeadingWhitespace, ignoreLeadingWhitespace) &&
			sameSearchSources(this.searchSources, searchSources)
		) {
			return false;
		}
		this.lines = [...lines];
		this.softWrapAfter = [...softWrapAfter];
		this.ignoreLeadingWhitespace = [...ignoreLeadingWhitespace];
		this.searchSources = searchSources.map((source) => source.map((segment) => ({ ...segment })));
		this.anchorRow = this.currentRow ?? this.anchorRow;
		this.releaseCorpus();
		if (this.active) this.ensureCorpus();
		return true;
	}

	routeInput(
		data: string,
		handleOutsidePaste: (data: string) => boolean,
		shouldDispatchPrefix: (data: string) => boolean = () => false,
	) {
		let changed = false;
		const input = this.pasteStartBuffer + data;
		this.pasteStartBuffer = "";
		let offset = 0;
		while (offset < input.length) {
			if (this.pasting) {
				const markerPrefix = this.pasteBuffer.slice(-(PASTE_END.length - 1));
				const combined = markerPrefix + input.slice(offset);
				const end = combined.indexOf(PASTE_END);
				const consumed =
					end < 0
						? input.length - offset
						: Math.max(0, end + PASTE_END.length - markerPrefix.length);
				const nextOffset = offset + consumed;
				changed = this.handleInput(input.slice(offset, nextOffset)) || changed;
				offset = nextOffset;
				continue;
			}
			const start = input.indexOf(PASTE_START, offset);
			if (start < 0) {
				const remainder = input.slice(offset);
				const prefixLength = trailingMarkerPrefixLength(remainder, PASTE_START);
				const outsidePaste = remainder.slice(0, remainder.length - prefixLength);
				if (outsidePaste && !handleOutsidePaste(outsidePaste)) {
					return { changed, stopped: true };
				}
				const prefix = remainder.slice(remainder.length - prefixLength);
				if (prefix && shouldDispatchPrefix(prefix)) {
					return { changed, stopped: !handleOutsidePaste(prefix) };
				}
				this.pasteStartBuffer = prefix;
				return { changed, stopped: false };
			}
			if (start > offset && !handleOutsidePaste(input.slice(offset, start))) {
				return { changed, stopped: true };
			}
			if (!this.active) return { changed, stopped: true };
			const end = input.indexOf(PASTE_END, start + PASTE_START.length);
			const nextOffset = end < 0 ? input.length : end + PASTE_END.length;
			changed = this.handleInput(input.slice(start, nextOffset)) || changed;
			offset = nextOffset;
		}
		return { changed, stopped: false };
	}

	handleInput(data: string) {
		const previous = this.input.getValue();
		const pasted = sanitizePastedSearchData(data, this.pasting, this.pasteBuffer);
		this.pasting = pasted.pasting;
		this.pasteBuffer = pasted.buffer;
		handleSearchInput(this.input, pasted.data);
		const bounded = truncateSearchQuery(this.input.getValue(), previous);
		if (bounded !== this.input.getValue()) this.input.setValue(bounded);
		if (this.input.getValue() === previous) return false;
		this.rebuildMatches();
		return true;
	}

	next() {
		if (this.count > 0) this.currentIndex = (this.currentIndex + 1) % this.count;
		this.anchorRow = this.currentRow ?? this.anchorRow;
		return this.currentRow;
	}

	previous() {
		if (this.count > 0) {
			this.currentIndex = (this.currentIndex - 1 + this.count) % this.count;
		}
		this.anchorRow = this.currentRow ?? this.anchorRow;
		return this.currentRow;
	}

	render(width: number): string {
		const prefix = "Find: ";
		const status = this.input.getValue() ? ` ${this.current}/${this.count}` : "";
		const inputWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status));
		const inputLine = this.input.render(inputWidth)[0] ?? "";
		return truncateToWidth(`${prefix}${inputLine}${status}`, Math.max(1, width), "");
	}

	highlight(lines: readonly string[], theme: SearchTheme): string[] {
		if (!this.active || this.count === 0) return [...lines];
		const rangesByRow = new Map<number, Array<CellRange & { current: boolean }>>();
		for (const [matchIndex, match] of this.highlightMatches()) {
			for (const range of match.ranges) {
				const ranges = rangesByRow.get(range.row) ?? [];
				ranges.push({ ...range, current: matchIndex === this.currentIndex });
				rangesByRow.set(range.row, ranges);
			}
		}
		return lines.map((line, row) => styleLine(line, rangesByRow.get(row) ?? [], theme));
	}

	invalidate() {
		this.input.invalidate();
		this.lines = [];
		this.softWrapAfter = [];
		this.ignoreLeadingWhitespace = [];
		this.searchSources = [];
		this.releaseCorpus();
		this.currentIndex = 0;
	}

	dispose() {
		this.close();
		this.parentFocused = false;
		this.syncFocus();
	}

	private syncFocus() {
		this.input.focused = this.parentFocused && this.active;
	}

	private ensureCorpus() {
		if (this.corpusReady) return;
		const corpus = buildCorpus(this.lines, this.softWrapAfter, this.ignoreLeadingWhitespace);
		this.corpus = corpus.text;
		this.cells = corpus.cells;
		this.corpusReady = true;
		this.rebuildMatches();
	}

	private releaseCorpus() {
		this.corpus = "";
		this.cells = emptyCorpusCells();
		this.corpusReady = false;
		this.compactMatchOffsets = undefined;
		this.compactMatchGroups = [];
		this.compactMatchGroupIndexes = new Uint32Array();
		this.compactMatchIndexes = new Uint32Array();
	}

	private rebuildMatches() {
		if (!this.corpusReady) {
			this.ensureCorpus();
			return;
		}
		this.anchorRow = this.currentRow ?? this.anchorRow;
		const query = normalizeQuery(this.input.getValue());
		this.compactMatchOffsets = undefined;
		this.compactMatchGroups = [];
		this.compactMatchGroupIndexes = new Uint32Array();
		this.compactMatchIndexes = new Uint32Array();
		if (query) {
			const sourceGroups: CompactMatchGroup[] = [];
			const matchingSources: DocumentSearchSource[] = [];
			for (const source of this.searchSources) {
				const sourceCorpus = buildSearchSourceCorpus(source);
				const offsets = findMatchOffsets(sourceCorpus.text, query);
				if (offsets.length > 0) {
					sourceGroups.push({ cells: sourceCorpus.cells, offsets });
					matchingSources.push(source);
				}
			}
			this.compactMatchOffsets = filterMatchOffsets(
				findMatchOffsets(this.corpus, query),
				this.corpus,
				this.cells,
				buildSearchSourceRanges(matchingSources),
			);
			if (this.compactMatchOffsets.length > 0) {
				this.compactMatchGroups.push({ cells: this.cells, offsets: this.compactMatchOffsets });
			}
			this.compactMatchGroups.push(...sourceGroups);
			const order = mergeCompactMatchGroups(this.compactMatchGroups);
			this.compactMatchGroupIndexes = order.groupIndexes;
			this.compactMatchIndexes = order.matchIndexes;
		}
		this.currentIndex = this.matchIndexAtOrAfter(this.anchorRow);
		this.anchorRow = this.currentRow ?? this.anchorRow;
	}

	private matchIndexAtOrAfter(row: number) {
		let low = 0;
		let high = this.count;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const middleRow = this.matchAt(middle)?.ranges[0]?.row ?? Number.POSITIVE_INFINITY;
			if (middleRow < row) low = middle + 1;
			else high = middle;
		}
		return low < this.count ? low : 0;
	}

	private currentMatch() {
		return this.matchAt(this.currentIndex);
	}

	private matchAt(index: number) {
		if (index < 0 || index >= this.count) return undefined;
		const groupIndex =
			this.compactMatchGroups.length === 1 ? 0 : (this.compactMatchGroupIndexes[index] ?? 0);
		const matchIndex =
			this.compactMatchGroups.length === 1 ? index : (this.compactMatchIndexes[index] ?? 0);
		const group = this.compactMatchGroups[groupIndex];
		if (!group) return undefined;
		return materializeMatch(
			group.cells,
			group.offsets[matchIndex * 2] ?? 0,
			group.offsets[matchIndex * 2 + 1] ?? 0,
		);
	}

	private highlightMatches(): [number, DocumentMatch][] {
		if (this.count > MAX_HIGHLIGHTED_MATCHES) {
			const current = this.currentMatch();
			return current ? [[this.currentIndex, current]] : [];
		}
		const matches: [number, DocumentMatch][] = [];
		for (let index = 0; index < this.count; index += 1) {
			const match = this.matchAt(index);
			if (match) matches.push([index, match]);
		}
		return matches;
	}
}

function buildCorpus(
	lines: readonly string[],
	softWrapAfter: readonly boolean[],
	ignoreLeadingWhitespace: readonly boolean[],
) {
	let text = "";
	const estimatedCells =
		lines.reduce((total, line) => total + line.length, 0) + Math.max(0, lines.length - 1);
	const cells = new CorpusCellBuilder(estimatedCells);
	let pendingRow = INVALID_CELL;
	let pendingStart = 0;
	let pendingEnd = 0;
	const setPendingWhitespace = (row: number, start: number, end: number) => {
		if (pendingRow !== INVALID_CELL) return;
		pendingRow = row;
		pendingStart = start;
		pendingEnd = end;
	};
	const appendWhitespace = () => {
		if (pendingRow === INVALID_CELL || text.endsWith(" ") || text.length === 0) return;
		text += " ";
		cells.push(pendingRow, pendingStart, pendingEnd);
	};
	const clearPendingWhitespace = () => {
		pendingRow = INVALID_CELL;
	};
	for (const [row, line] of lines.entries()) {
		let column = 0;
		let hasContent = false;
		const appendSegment = (segment: string, width: number) => {
			const start = column;
			const end = column + width;
			if (/^\s+$/u.test(segment)) {
				if (hasContent || !ignoreLeadingWhitespace[row]) setPendingWhitespace(row, start, end);
			} else {
				appendWhitespace();
				clearPendingWhitespace();
				hasContent = true;
				text += segment;
				for (let index = 0; index < segment.length; index += 1) cells.push(row, start, end);
			}
			column = end;
		};
		const plain = stripTerminalSequences(line);
		if (/^[\x20-\x7e]*$/u.test(plain)) {
			let index = 0;
			while (index < plain.length) {
				if (plain[index] === " ") {
					if (hasContent || !ignoreLeadingWhitespace[row]) {
						setPendingWhitespace(row, column, column + 1);
					}
					while (plain[index] === " ") {
						index += 1;
						column += 1;
					}
					continue;
				}
				const start = index;
				while (index < plain.length && plain[index] !== " ") index += 1;
				appendWhitespace();
				clearPendingWhitespace();
				hasContent = true;
				const run = plain.slice(start, index);
				text += run;
				for (let offset = 0; offset < run.length; offset += 1) {
					cells.push(row, column + offset, column + offset + 1);
				}
				column += run.length;
			}
		} else {
			for (const { segment } of graphemeSegmenter.segment(plain)) {
				appendSegment(segment, visibleWidth(segment));
			}
		}
		if (!softWrapAfter[row]) setPendingWhitespace(row, column, column);
	}
	return { text, cells: cells.finish() };
}

function buildSearchSourceCorpus(source: DocumentSearchSource) {
	let text = "";
	const estimatedCells =
		source.reduce((total, segment) => total + segment.text.length, 0) +
		Math.max(0, source.length - 1);
	const cells = new CorpusCellBuilder(estimatedCells);
	let pendingRow = INVALID_CELL;
	let pendingStart = 0;
	let pendingEnd = 0;
	const setPendingWhitespace = (row: number, start: number, end: number) => {
		if (pendingRow !== INVALID_CELL) return;
		pendingRow = row;
		pendingStart = start;
		pendingEnd = end;
	};
	const appendWhitespace = () => {
		if (pendingRow === INVALID_CELL || text.endsWith(" ") || text.length === 0) return;
		text += " ";
		cells.push(pendingRow, pendingStart, pendingEnd);
	};
	for (const segment of source) {
		let column = segment.column;
		if (segment.separatorBefore) setPendingWhitespace(segment.row, column, column);
		for (const { segment: grapheme } of graphemeSegmenter.segment(segment.text)) {
			const width = visibleWidth(grapheme);
			const start = column;
			const end = column + width;
			if (/^\s+$/u.test(grapheme)) setPendingWhitespace(segment.row, start, end);
			else {
				appendWhitespace();
				pendingRow = INVALID_CELL;
				text += grapheme;
				for (let index = 0; index < grapheme.length; index += 1) {
					cells.push(segment.row, start, end);
				}
			}
			column = end;
		}
	}
	return { text, cells: cells.finish() };
}

function sanitizePastedSearchData(data: string, initiallyPasting: boolean, initialBuffer: string) {
	let result = "";
	let offset = 0;
	let pasting = initiallyPasting;
	let buffer = initialBuffer;
	while (offset < data.length) {
		if (pasting) {
			const combined = buffer + data.slice(offset);
			const end = combined.indexOf(PASTE_END);
			if (end < 0) {
				return { data: result, pasting, buffer: appendPasteBuffer(buffer, data.slice(offset)) };
			}
			result += sanitizeSearchQuery(combined.slice(0, end)) + PASTE_END;
			const consumed = Math.max(0, end + PASTE_END.length - buffer.length);
			buffer = "";
			offset += consumed;
			pasting = false;
			continue;
		}
		const start = data.indexOf(PASTE_START, offset);
		if (start < 0) {
			return {
				data: result + sanitizeUnbracketedSearchData(data.slice(offset)),
				pasting,
				buffer,
			};
		}
		result += sanitizeUnbracketedSearchData(data.slice(offset, start)) + PASTE_START;
		offset = start + PASTE_START.length;
		pasting = true;
	}
	return { data: result, pasting, buffer };
}

function appendPasteBuffer(buffer: string, value: string) {
	const combined = buffer + value;
	if (combined.length <= MAX_PASTE_BUFFER_LENGTH) return combined;
	const tailLength = PASTE_END.length - 1;
	return combined.slice(0, MAX_PASTE_BUFFER_LENGTH - tailLength) + combined.slice(-tailLength);
}

function trailingMarkerPrefixLength(value: string, marker: string) {
	for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
		if (marker.startsWith(value.slice(-length))) return length;
	}
	return 0;
}

function sanitizeUnbracketedSearchData(value: string) {
	const kittyPrintable = decodeKittyPrintable(value);
	if (kittyPrintable !== undefined) return sanitizeTerminalDocument(kittyPrintable);
	const hasTerminalControl = Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
	return hasTerminalControl ? value : sanitizeTerminalDocument(value);
}

function truncateSearchQuery(value: string, preservedPrefix?: string) {
	if (value.length <= MAX_SEARCH_QUERY_LENGTH) return value;
	let end = 0;
	for (const { index, segment } of graphemeSegmenter.segment(value)) {
		const next = index + segment.length;
		if (next > MAX_SEARCH_QUERY_LENGTH) break;
		end = next;
	}
	const truncated = value.slice(0, end);
	if (
		preservedPrefix !== undefined &&
		preservedPrefix.length <= MAX_SEARCH_QUERY_LENGTH &&
		value.startsWith(preservedPrefix) &&
		truncated.length < preservedPrefix.length
	) {
		return preservedPrefix;
	}
	return truncated;
}

function sanitizeSearchQuery(value: string) {
	return truncateSearchQuery(sanitizeTerminalDocument(value).replace(/\s+/gu, " "));
}

function normalizeQuery(value: string) {
	return sanitizeSearchQuery(value).trim();
}

function findMatchOffsets(corpus: string, query: string) {
	if (query.length > corpus.length) return new Uint32Array();
	const offsets = new MatchOffsetBuilder();
	if (/^[\x20-\x7e]+$/u.test(query) && /^[\x20-\x7e]*$/u.test(corpus)) {
		const haystack = corpus.toLowerCase();
		const needle = query.toLowerCase();
		let offset = 0;
		while (offset <= haystack.length - needle.length) {
			const match = haystack.indexOf(needle, offset);
			if (match < 0) break;
			offsets.push(match, match + needle.length);
			offset = match + needle.length;
		}
		return offsets.finish();
	}
	const expression = new RegExp(escapeRegExp(query), "giu");
	for (const match of corpus.matchAll(expression)) {
		offsets.push(match.index, match.index + match[0].length);
	}
	return offsets.finish();
}

interface SearchSourceRange {
	start: number;
	end: number;
}

interface IndexedSearchSourceRange extends SearchSourceRange {
	sourceIndex: number;
}

function buildSearchSourceRanges(sources: readonly DocumentSearchSource[]) {
	const byRow = new Map<number, IndexedSearchSourceRange[]>();
	const bySource = sources.map(() => new Map<number, SearchSourceRange[]>());
	for (const [sourceIndex, source] of sources.entries()) {
		for (const segment of source) {
			const range = {
				start: segment.column,
				end: segment.column + visibleWidth(segment.text),
			};
			const rowRanges = byRow.get(segment.row) ?? [];
			rowRanges.push({ ...range, sourceIndex });
			byRow.set(segment.row, rowRanges);
			const sourceRowRanges = bySource[sourceIndex]?.get(segment.row) ?? [];
			sourceRowRanges.push(range);
			bySource[sourceIndex]?.set(segment.row, sourceRowRanges);
		}
	}
	return { byRow, bySource };
}

function filterMatchOffsets(
	offsets: Uint32Array,
	corpus: string,
	cells: CorpusCells,
	sourceRanges: ReturnType<typeof buildSearchSourceRanges>,
) {
	if (sourceRanges.bySource.length === 0) return offsets;
	const retained = new MatchOffsetBuilder();
	for (let index = 0; index < offsets.length; index += 2) {
		const start = offsets[index] ?? 0;
		const end = offsets[index + 1] ?? start;
		const row = cells.rows[start] ?? INVALID_CELL;
		const cellStart = cells.starts[start] ?? 0;
		const cellEnd = cells.ends[start] ?? 0;
		const contained = sourceRanges.byRow
			.get(row)
			?.some(
				(range) =>
					cellStart >= range.start &&
					cellEnd <= range.end &&
					matchContainedInSource(
						corpus,
						cells,
						start,
						end,
						sourceRanges.bySource[range.sourceIndex],
					),
			);
		if (!contained) retained.push(start, end);
	}
	return retained.finish();
}

function matchContainedInSource(
	corpus: string,
	cells: CorpusCells,
	start: number,
	end: number,
	sourceRanges: ReadonlyMap<number, readonly SearchSourceRange[]> | undefined,
) {
	if (!sourceRanges) return false;
	let hasVisibleCell = false;
	for (let index = start; index < end; index += 1) {
		const row = cells.rows[index] ?? INVALID_CELL;
		const cellStart = cells.starts[index] ?? 0;
		const cellEnd = cells.ends[index] ?? 0;
		if (row === INVALID_CELL || cellEnd <= cellStart) continue;
		hasVisibleCell = true;
		const contained = sourceRanges
			.get(row)
			?.some((range) => cellStart >= range.start && cellEnd <= range.end);
		if (!contained && corpus[index] !== " ") return false;
	}
	return hasVisibleCell;
}

function mergeCompactMatchGroups(groups: readonly CompactMatchGroup[]) {
	if (groups.length < 2) {
		return { groupIndexes: new Uint32Array(), matchIndexes: new Uint32Array() };
	}
	const total = groups.reduce((count, group) => count + group.offsets.length / 2, 0);
	const groupIndexes = new Uint32Array(total);
	const matchIndexes = new Uint32Array(total);
	const positions = new Uint32Array(groups.length);
	const heap = groups.map((_, groupIndex) => groupIndex);
	const precedes = (leftGroup: number, rightGroup: number) => {
		const comparison = compareCompactMatchStarts(
			groups[leftGroup],
			positions[leftGroup] ?? 0,
			groups[rightGroup],
			positions[rightGroup] ?? 0,
		);
		return comparison < 0 || (comparison === 0 && leftGroup < rightGroup);
	};
	const siftDown = (start: number) => {
		let parent = start;
		while (true) {
			const left = parent * 2 + 1;
			if (left >= heap.length) return;
			const right = left + 1;
			const child =
				right < heap.length && precedes(heap[right] ?? 0, heap[left] ?? 0) ? right : left;
			if (precedes(heap[parent] ?? 0, heap[child] ?? 0)) return;
			[heap[parent], heap[child]] = [heap[child] ?? 0, heap[parent] ?? 0];
			parent = child;
		}
	};
	for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) siftDown(index);
	for (let target = 0; target < total; target += 1) {
		const groupIndex = heap[0] ?? 0;
		const matchIndex = positions[groupIndex] ?? 0;
		groupIndexes[target] = groupIndex;
		matchIndexes[target] = matchIndex;
		positions[groupIndex] = matchIndex + 1;
		if (positions[groupIndex] >= (groups[groupIndex]?.offsets.length ?? 0) / 2) {
			heap[0] = heap.at(-1) ?? 0;
			heap.pop();
		}
		if (heap.length > 0) siftDown(0);
	}
	return { groupIndexes, matchIndexes };
}

function compareCompactMatchStarts(
	left: CompactMatchGroup | undefined,
	leftIndex: number,
	right: CompactMatchGroup | undefined,
	rightIndex: number,
) {
	const leftOffset = left?.offsets[leftIndex * 2] ?? 0;
	const rightOffset = right?.offsets[rightIndex * 2] ?? 0;
	return (
		(left?.cells.rows[leftOffset] ?? 0) - (right?.cells.rows[rightOffset] ?? 0) ||
		(left?.cells.starts[leftOffset] ?? 0) - (right?.cells.starts[rightOffset] ?? 0)
	);
}

function materializeMatch(cells: CorpusCells, start: number, end: number): DocumentMatch {
	const byRow = new Map<number, CellRange>();
	for (let index = start; index < end; index += 1) {
		const row = cells.rows[index] ?? INVALID_CELL;
		const cellStart = cells.starts[index] ?? 0;
		const cellEnd = cells.ends[index] ?? 0;
		if (row === INVALID_CELL || cellEnd <= cellStart) continue;
		const range = byRow.get(row);
		if (range) {
			range.start = Math.min(range.start, cellStart);
			range.end = Math.max(range.end, cellEnd);
		} else byRow.set(row, { row, start: cellStart, end: cellEnd });
	}
	return { ranges: [...byRow.values()] };
}

function styleLine(
	line: string,
	ranges: readonly (CellRange & { current: boolean })[],
	theme: SearchTheme,
) {
	if (ranges.length === 0) return line;
	let result = "";
	let column = 0;
	for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
		if (range.start < column) continue;
		result += sliceByColumn(line, column, range.start - column, true);
		let target = sliceByColumn(line, range.start, range.end - range.start, true);
		target = theme.fg("searchMatchText", target);
		target = theme.bg?.("searchMatchBg", target) ?? target;
		if (range.current) target = theme.bold(theme.inverse?.(target) ?? target);
		else target = theme.underline?.(target) ?? target;
		result += target;
		column = range.end;
	}
	result += sliceByColumn(line, column, Math.max(0, visibleWidth(line) - column), true);
	return result;
}

function sameLines(left: readonly string[], right: readonly string[]) {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function sameValues<T>(left: readonly T[], right: readonly T[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSearchSources(
	left: readonly DocumentSearchSource[],
	right: readonly DocumentSearchSource[],
) {
	return (
		left.length === right.length &&
		left.every(
			(source, sourceIndex) =>
				source.length === right[sourceIndex]?.length &&
				source.every((segment, segmentIndex) => {
					const other = right[sourceIndex]?.[segmentIndex];
					return (
						other !== undefined &&
						segment.row === other.row &&
						segment.column === other.column &&
						segment.text === other.text &&
						segment.separatorBefore === other.separatorBefore
					);
				}),
		)
	);
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
