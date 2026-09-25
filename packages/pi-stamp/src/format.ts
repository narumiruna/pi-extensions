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
  showTimeSinceUser: boolean;
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
  showTimeSinceUser: false,
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
  timeSinceUserMs?: number;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: string;
  second: string;
}

type FormatterSlot = "localized-date" | "localized-time" | "zoned-parts";

interface CachedFormatter {
  key: string;
  formatter: Intl.DateTimeFormat;
}

interface CachedDefaultFormatEnvironment extends StampFormatEnvironment {
  checkedAt: number;
  tz: string | undefined;
  lcAll: string | undefined;
  lcTime: string | undefined;
  lang: string | undefined;
}

// Host locale and time-zone settings can change without updating the process environment.
const DEFAULT_ENVIRONMENT_REFRESH_MS = 60_000;
const EMPTY_FORMAT_ENVIRONMENT: Readonly<StampFormatEnvironment> = Object.freeze({});
const formatterCache: Partial<Record<FormatterSlot, CachedFormatter>> = {};
let cachedDefaultFormatEnvironment: CachedDefaultFormatEnvironment | undefined;

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

export function resolveStampFormatEnvironment(
  settings: Readonly<StampSettings>,
  environment: Readonly<StampFormatEnvironment> = EMPTY_FORMAT_ENVIRONMENT,
): Readonly<StampFormatEnvironment> {
  const needsSystemLocale = settings.locale === "system" && environment.systemLocale === undefined;
  const needsLocalTimeZone = settings.timeZone === "local" && environment.localTimeZone === undefined;
  if (!needsSystemLocale && !needsLocalTimeZone) return environment;

  const defaults = resolveDefaultFormatEnvironment();
  if (environment === EMPTY_FORMAT_ENVIRONMENT) return defaults;
  return {
    systemLocale: environment.systemLocale ?? defaults.systemLocale,
    localTimeZone: environment.localTimeZone ?? defaults.localTimeZone,
  };
}

export function formatStampLabel(
  timestamp: number,
  previousTimestamp: number | undefined,
  settings: Readonly<StampSettings>,
  environment: Readonly<StampFormatEnvironment> = EMPTY_FORMAT_ENVIRONMENT,
): string | undefined {
  if (!isValidTimestamp(timestamp)) return undefined;
  try {
    const resolvedEnvironment = resolveStampFormatEnvironment(settings, environment);
    const timeZone = settings.timeZone === "local" ? resolvedEnvironment.localTimeZone : settings.timeZone;
    const showDate = shouldShowDate(timestamp, previousTimestamp, settings.dateContext, timeZone);
    if (settings.locale === "invariant") {
      return formatInvariant(timestamp, showDate, settings, timeZone);
    }
    const locale = settings.locale === "system" ? resolvedEnvironment.systemLocale : settings.locale;
    return formatLocalized(timestamp, showDate, settings, locale, timeZone);
  } catch {
    return undefined;
  }
}

export function formatMessageStampLabel(
  input: Readonly<MessageStampFormatInput>,
  settings: Readonly<StampSettings>,
  environment: Readonly<StampFormatEnvironment> = EMPTY_FORMAT_ENVIRONMENT,
): string | undefined {
  const label = formatStampLabel(input.timestamp, input.previousTimestamp, settings, environment);
  if (!label) return undefined;
  const sinceUser =
    settings.showTimeSinceUser && input.timeSinceUserMs !== undefined
      ? formatTimeSinceUser(input.timeSinceUserMs)
      : undefined;
  const response = formatResponseTimingLabel(input, settings, label, sinceUser !== undefined);
  return sinceUser === undefined ? response : `${response} · since user ${sinceUser}`;
}

function formatResponseTimingLabel(
  input: Readonly<MessageStampFormatInput>,
  settings: Readonly<StampSettings>,
  label: string,
  labelResponse: boolean,
): string {
  if (settings.responseTiming === "off") return label;
  if (!isValidTimestamp(input.completedAt) || input.completedAt < input.timestamp) return label;
  const total = formatResponseElapsed(input.completedAt - input.timestamp);
  if (!total) return label;
  if (settings.responseTiming === "duration") return `${label} · ${labelResponse ? "response " : ""}${total}`;
  const first =
    isValidTimestamp(input.firstContentAt) &&
    input.firstContentAt >= input.timestamp &&
    input.firstContentAt <= input.completedAt
      ? formatResponseElapsed(input.firstContentAt - input.timestamp)
      : undefined;
  return `${label} · first ${first ?? "n/a"} · total ${total}`;
}

export function formatTimeSinceUser(elapsedMilliseconds: number): string | undefined {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) return undefined;
  if (elapsedMilliseconds < 60_000) {
    // Carry rounded seconds into minutes without changing truncation for longer durations.
    return Math.round(elapsedMilliseconds / 100) === 600 ? "1m 0s" : formatElapsedSeconds(elapsedMilliseconds);
  }
  const seconds = Math.floor(elapsedMilliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

export function formatResponseElapsed(elapsedMilliseconds: number): string | undefined {
  return formatElapsedSeconds(elapsedMilliseconds);
}

export function formatExactTimelineLine(boundary: StampTimelineBoundary, timestamp: number): string | undefined {
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
  const hour = settings.hourCycle === "24h" ? String(parts.hour).padStart(2, "0") : String(parts.hour % 12 || 12);
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
  const time = cachedFormatter(
    "localized-time",
    JSON.stringify([locale, timeZone, settings.showSeconds, settings.hourCycle]),
    () =>
      new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        ...(settings.showSeconds ? { second: "2-digit" as const } : {}),
        hourCycle: settings.hourCycle === "24h" ? "h23" : "h12",
      }),
  ).format(date);
  if (!showDate) return time;
  const formattedDate = cachedFormatter(
    "localized-date",
    JSON.stringify([locale, timeZone]),
    () =>
      new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        timeZone,
        dateStyle: "medium",
      }),
  ).format(date);
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
  const formatter = cachedFormatter(
    "zoned-parts",
    JSON.stringify([timeZone]),
    () =>
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
      }),
  );
  const values = new Map(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
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

function resolveDefaultFormatEnvironment(): CachedDefaultFormatEnvironment {
  const now = Date.now();
  const tz = process.env.TZ;
  const lcAll = process.env.LC_ALL;
  const lcTime = process.env.LC_TIME;
  const lang = process.env.LANG;
  const elapsed = cachedDefaultFormatEnvironment ? now - cachedDefaultFormatEnvironment.checkedAt : undefined;
  if (
    cachedDefaultFormatEnvironment &&
    elapsed !== undefined &&
    elapsed >= 0 &&
    elapsed < DEFAULT_ENVIRONMENT_REFRESH_MS &&
    cachedDefaultFormatEnvironment.tz === tz &&
    cachedDefaultFormatEnvironment.lcAll === lcAll &&
    cachedDefaultFormatEnvironment.lcTime === lcTime &&
    cachedDefaultFormatEnvironment.lang === lang
  ) {
    return cachedDefaultFormatEnvironment;
  }

  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  cachedDefaultFormatEnvironment = {
    checkedAt: now,
    tz,
    lcAll,
    lcTime,
    lang,
    systemLocale: locale,
    localTimeZone: timeZone,
  };
  return cachedDefaultFormatEnvironment;
}

function cachedFormatter(slot: FormatterSlot, key: string, create: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const cached = formatterCache[slot];
  if (cached?.key === key) return cached.formatter;
  const formatter = create();
  formatterCache[slot] = { key, formatter };
  return formatter;
}

function isValidTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}
