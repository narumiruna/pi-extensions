import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RenderSegment, SeparatorName, StatuslineConfig } from "./types.js";

export function renderClassicStatusline(
	width: number,
	segments: RenderSegment[],
	theme: Theme,
	config: StatuslineConfig,
): string {
	return truncateToWidth(joinSegments(segments, theme, config), width, "");
}

export function classicExtensionSeparator(theme: Theme): string {
	return theme.fg("dim", " • ");
}

function joinSegments(segments: RenderSegment[], theme: Theme, config: StatuslineConfig): string {
	const separator = separatorText(config.separator);
	return segments
		.map((segment, index) => styleSegment(segment, index, theme, config))
		.join(theme.fg("dim", separator));
}

function styleSegment(
	segment: RenderSegment,
	index: number,
	theme: Theme,
	config: StatuslineConfig,
): string {
	const padding = config.density === "cozy" ? " " : "";
	const text = `${padding}${segment.text}${padding}`;
	const styledText = segment.emphasis ? theme.bold(text) : text;

	if (config.palette === "mono") {
		return index === 0 ? theme.fg("muted", styledText) : theme.fg("dim", styledText);
	}

	return theme.fg(segment.color as ThemeColor, styledText);
}

function separatorText(separator: SeparatorName): string {
	switch (separator) {
		case "powerline":
			return "  ";
		case "bar":
			return " │ ";
		case "round":
			return " ❯ ";
		case "none":
			return " ";
		case "dot":
			return " • ";
	}
}
