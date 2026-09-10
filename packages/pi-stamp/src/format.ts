import { formatElapsedSeconds, type StampAssistantMetadataMode } from "./metadata.js";

export type { StampAssistantMetadataMode } from "./metadata.js";
export { ASSISTANT_METADATA_MODES } from "./metadata.js";

export const HOUR_CYCLES = ["24h", "12h"] as const;
export const DATE_CONTEXTS = ["day-change", "always", "never"] as const;
export const RESPONSE_TIMING_MODES = ["off", "duration", "detailed"] as const;
export const TIMELINE_BOUNDARIES = ["created", "first content", "started", "completed"] as const;

export type StampHourCycle = (typeof HOUR_CYCLES)[number];
export type StampDateContext = (typeof DATE_CONTEXTS)[number];
export type StampResponseTimingMode = (typeof RESPONSE_TIMING_MODES)[number];
export type StampTimelineBoundary = (typeof TIMELINE_BOUNDARIES)[number];
export type StampLocale = "invariant" | "system" | string;
export type StampTimeZone = "local" | string;

export interface StampSettings {
	hourCycle: StampHourCycle;
	showSeconds: boolean;
	dateContext: StampDateContext;
	locale: StampLocale;
	timeZone: StampTimeZone;
	responseTiming: StampResponseTimingMode;
	assistantMetadata: StampAssistantMetadataMode;
	showExactTimeline: boolean;
	showThinkingLevel: boolean;
	showCompactAbnormalOutcome: boolean;
	showCostSinceUser: boolean;
	toolStamps: boolean;
}

export const DEFAULT_STAMP_SETTINGS: Readonly<StampSettings> = Object.freeze({
	hourCycle: "24h",
	showSeconds: true,
	dateContext: "day-change",
	locale: "invariant",
	timeZone: "local",
	responseTiming: "off",
	assistantMetadata: "off",
	showExactTimeline: true,
	showThinkingLevel: true,
	showCompactAbnormalOutcome: true,
	showCostSinceUser: false,
	toolStamps: false,
});

export interface StampFormatEnvironment {
	systemLocale?: string;
	localTimeZone?: string;
}

export interface MessageStampFormatInput {
	timestamp: number;
	previousTimestamp?: number;
	completedAt?: number;
	firstContentAt?: number;
}

interface ZonedParts {
	year: string;
	month: string;
	day: string;
	hour: number;
	minute: string;
	second: string;
}

export function canonicalizeLocale(value: string): string | undefined {
	if (value === "invariant" || value === "system") return value;
	try {
		const locales = Intl.getCanonicalLocales(value);
		return locales.length === 1 ? locales[0] : undefined;
	} catch {
		return undefined;
	}
}

export function canonicalizeTimeZone(value: string): string | undefined {
	if (value === "local") return value;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

export function formatStampLabel(
	timestamp: number,
	previousTimestamp: number | undefined,
	settings: Readonly<StampSettings>,
	environment: StampFormatEnvironment = {},
): string | undefined {
	if (!isValidTimestamp(timestamp)) return undefined;
	try {
		const timeZone = settings.timeZone === "local" ? environment.localTimeZone : settings.timeZone;
		const showDate = shouldShowDate(timestamp, previousTimestamp, settings.dateContext, timeZone);
		if (settings.locale === "invariant") {
			return formatInvariant(timestamp, showDate, settings, timeZone);
		}
		const locale = settings.locale === "system" ? environment.systemLocale : settings.locale;
		return formatLocalized(timestamp, showDate, settings, locale, timeZone);
	} catch {
		return undefined;
	}
}

export function formatMessageStampLabel(
	input: Readonly<MessageStampFormatInput>,
	settings: Readonly<StampSettings>,
	environment: StampFormatEnvironment = {},
): string | undefined {
	const label = formatStampLabel(input.timestamp, input.previousTimestamp, settings, environment);
	if (!label || settings.responseTiming === "off") return label;
	if (!isValidTimestamp(input.completedAt) || input.completedAt < input.timestamp) return label;
	const total = formatResponseElapsed(input.completedAt - input.timestamp);
	if (!total) return label;
	if (settings.responseTiming === "duration") return `${label} · ${total}`;
	const first =
		isValidTimestamp(input.firstContentAt) &&
		input.firstContentAt >= input.timestamp &&
		input.firstContentAt <= input.completedAt
			? formatResponseElapsed(input.firstContentAt - input.timestamp)
			: undefined;
	return `${label} · first ${first ?? "n/a"} · total ${total}`;
}

export function formatResponseElapsed(elapsedMilliseconds: number): string | undefined {
	return formatElapsedSeconds(elapsedMilliseconds);
}

export function formatExactTimelineLine(
	boundary: StampTimelineBoundary,
	timestamp: number,
): string | undefined {
	if (!TIMELINE_BOUNDARIES.includes(boundary) || !isValidTimestamp(timestamp)) return undefined;
	return `timeline · ${boundary} ${new Date(timestamp).toISOString()} · unix-ms ${timestamp}`;
}

function formatInvariant(
	timestamp: number,
	showDate: boolean,
	settings: Readonly<StampSettings>,
	timeZone: string | undefined,
): string {
	const parts = zonedParts(timestamp, timeZone);
	const hour =
		settings.hourCycle === "24h"
			? String(parts.hour).padStart(2, "0")
			: String(parts.hour % 12 || 12);
	const seconds = settings.showSeconds ? `:${parts.second}` : "";
	const period = settings.hourCycle === "12h" ? (parts.hour < 12 ? " AM" : " PM") : "";
	const time = `${hour}:${parts.minute}${seconds}${period}`;
	return showDate ? `${parts.year}-${parts.month}-${parts.day} · ${time}` : time;
}

function formatLocalized(
	timestamp: number,
	showDate: boolean,
	settings: Readonly<StampSettings>,
	locale: string | undefined,
	timeZone: string | undefined,
): string {
	const date = new Date(timestamp);
	const time = new Intl.DateTimeFormat(locale, {
		calendar: "gregory",
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		...(settings.showSeconds ? { second: "2-digit" as const } : {}),
		hourCycle: settings.hourCycle === "24h" ? "h23" : "h12",
	}).format(date);
	if (!showDate) return time;
	const formattedDate = new Intl.DateTimeFormat(locale, {
		calendar: "gregory",
		timeZone,
		dateStyle: "medium",
	}).format(date);
	return `${formattedDate} · ${time}`;
}

function shouldShowDate(
	timestamp: number,
	previousTimestamp: number | undefined,
	dateContext: StampDateContext,
	timeZone: string | undefined,
): boolean {
	if (dateContext === "always") return true;
	if (dateContext === "never" || !isValidTimestamp(previousTimestamp)) return false;
	return dateKey(timestamp, timeZone) !== dateKey(previousTimestamp, timeZone);
}

function dateKey(timestamp: number, timeZone: string | undefined): string {
	const parts = zonedParts(timestamp, timeZone);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedParts(timestamp: number, timeZone: string | undefined): ZonedParts {
	const values = new Map(
		new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
			calendar: "gregory",
			numberingSystem: "latn",
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(timestamp))
			.map((part) => [part.type, part.value]),
	);
	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	const hour = Number(values.get("hour"));
	const minute = values.get("minute");
	const second = values.get("second");
	if (!year || !month || !day || !Number.isInteger(hour) || !minute || !second) {
		throw new Error("Intl did not return complete Gregorian date/time parts.");
	}
	return { year, month, day, hour, minute, second };
}

function isValidTimestamp(value: number | undefined): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
	);
}
