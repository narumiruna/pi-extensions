const MAX_TIME_FORMAT_LENGTH = 256;
const MAX_TIME_ZONE_LENGTH = 128;
const MAX_TIME_RANGE_LENGTH = 64;
const FORMAT_TOKEN = /%%|%:z|%[HIMSpPRTrYmdFz]/gu;

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetSeconds: number;
}

interface TimeOptions {
  use_12hr?: unknown;
  time_format?: unknown;
  utc_time_offset?: unknown;
  time_range?: unknown;
}

// Only the latest configured zone is retained. The default local clock does not
// construct an Intl formatter, and no timer or filesystem operation is used here.
let cachedZone: { name: string; formatter: Intl.DateTimeFormat } | undefined;

/**
 * Supported strftime tokens: %% %H %I %M %S %p %P %R %T %r %Y %m %d %F %z %:z.
 * Other directives, flags, and formats over 256 characters fall back to the
 * minutes-only Pi default. An empty format selects that default as well.
 */
export function formatClockTime(now: Date, options: TimeOptions): string | undefined {
  if (!Number.isFinite(now.getTime())) return undefined;
  // Starship gates visibility against local wall time, not the output zone.
  if (!isInsideTimeRange(now, options.time_range)) return undefined;
  const fallback = options.use_12hr === true ? "%I:%M %p" : "%H:%M";
  const format = validTimeFormat(options.time_format) ? options.time_format : fallback;
  const parts = clockParts(now, options.utc_time_offset);
  const hour12 = parts.hour % 12 || 12;
  const period = parts.hour < 12 ? "AM" : "PM";
  const hours = pad(parts.hour);
  const minutes = pad(parts.minute);
  const seconds = pad(parts.second);
  const date = `${parts.year.toString().padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
  const tokens: Readonly<Record<string, string>> = {
    "%%": "%",
    "%H": hours,
    "%I": pad(hour12),
    "%M": minutes,
    "%S": seconds,
    "%p": period,
    "%P": period.toLowerCase(),
    "%R": `${hours}:${minutes}`,
    "%T": `${hours}:${minutes}:${seconds}`,
    // Jiff's %r uses an unpadded 12-hour value.
    "%r": `${hour12}:${minutes}:${seconds} ${period}`,
    "%Y": parts.year.toString().padStart(4, "0"),
    "%m": pad(parts.month),
    "%d": pad(parts.day),
    "%F": date,
    "%z": offsetText(parts.offsetSeconds, ""),
    "%:z": offsetText(parts.offsetSeconds, ":"),
  };
  return format.replace(FORMAT_TOKEN, (token) => tokens[token] ?? token);
}

export function validTimeFormat(format: unknown): format is string {
  return (
    typeof format === "string" &&
    format.length > 0 &&
    format.length <= MAX_TIME_FORMAT_LENGTH &&
    !format.replace(FORMAT_TOKEN, "").includes("%")
  );
}

/**
 * Range endpoints use HH:MM, HH:MM:SS, or HH:MM:SS.sss (1–3 fractional
 * digits). Each endpoint is optional. Invalid endpoints are ignored separately;
 * a missing or repeated hyphen disables the gate. Endpoints are exclusive,
 * including equal endpoints, which exclude only that exact local wall time.
 * Inputs over 64 characters disable the gate.
 */
export function isInsideTimeRange(now: Date, range: unknown): boolean {
  if (typeof range !== "string" || range.length > MAX_TIME_RANGE_LENGTH) return true;
  const endpoints = range.split("-");
  if (endpoints.length !== 2) return true;
  const start = parseRangeEndpoint(endpoints[0] ?? "");
  const end = parseRangeEndpoint(endpoints[1] ?? "");
  const current = ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1_000 + now.getMilliseconds();
  if (start === undefined && end === undefined) return true;
  if (start === undefined) return current < (end as number);
  if (end === undefined) return current > start;
  return start < end ? current > start && current < end : current > start || current < end;
}

function parseRangeEndpoint(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return ((hour * 60 + minute) * 60 + second) * 1_000 + Number((match[4] ?? "").padEnd(3, "0"));
}

// Zones are local, UTC, or an Intl-supported Area/Zone identifier. Numeric
// offsets allow an optional sign, 1–2 integer digits, and an optional 1–6 digit
// fraction, strictly between -24 and 24, truncated to seconds. Inputs over 128 characters
// and all other syntax fall back to local time.
function clockParts(now: Date, zone: unknown): ClockParts {
  if (typeof zone !== "string" || zone === "local" || zone.length > MAX_TIME_ZONE_LENGTH) return localParts(now);
  if (/^[+-]?\d{1,2}(?:\.\d{1,6})?$/u.test(zone)) {
    const hours = Number(zone);
    if (hours > -24 && hours < 24) {
      const offsetSeconds = Math.trunc(hours * 3_600);
      const shifted = new Date(now.getTime() + offsetSeconds * 1_000);
      return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        second: shifted.getUTCSeconds(),
        offsetSeconds,
      };
    }
    return localParts(now);
  }
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/u.test(zone)) return localParts(now);
  try {
    if (cachedZone?.name !== zone) {
      cachedZone = {
        name: zone,
        formatter: new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          calendar: "iso8601",
          numberingSystem: "latn",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }),
      };
    }
    const values = Object.fromEntries(cachedZone.formatter.formatToParts(now).map(({ type, value }) => [type, value]));
    const parts = {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    };
    const wallTime = new Date(0);
    wallTime.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    wallTime.setUTCHours(parts.hour, parts.minute, parts.second, 0);
    return {
      ...parts,
      offsetSeconds: (wallTime.getTime() - Math.floor(now.getTime() / 1_000) * 1_000) / 1_000,
    };
  } catch {
    return localParts(now);
  }
}

function localParts(now: Date): ClockParts {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
    offsetSeconds: -now.getTimezoneOffset() * 60,
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function offsetText(seconds: number, separator: string): string {
  const absolute = Math.abs(seconds);
  return `${seconds < 0 ? "-" : "+"}${pad(Math.floor(absolute / 3_600))}${separator}${pad(Math.floor((absolute % 3_600) / 60))}`;
}
