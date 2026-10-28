import { RE2JS } from "re2js";

const MAX_PATTERN = 512;
const MAX_VALUE = 4_096;
const MAX_OUTPUT = 8_192;
const CACHE_SIZE = 64;
const patterns = new Map<string, RE2JS | null>();

// RE2 rejects backreferences and lookaround and matches without backtracking.
// Bound compilation, input, replacement, output, and retained compiled patterns.
function compile(pattern: string): RE2JS | undefined {
  const sourceLength = pattern.startsWith("^(?:") && pattern.endsWith(")$") ? pattern.length - 6 : pattern.length;
  if (sourceLength > MAX_PATTERN) return undefined;
  if (patterns.has(pattern)) return patterns.get(pattern) ?? undefined;
  let compiled: RE2JS | null;
  try {
    compiled = RE2JS.compile(pattern);
  } catch {
    compiled = null;
  }
  if (patterns.size >= CACHE_SIZE) {
    const oldest = patterns.keys().next().value;
    if (oldest !== undefined) patterns.delete(oldest);
  }
  patterns.set(pattern, compiled);
  return compiled ?? undefined;
}

export function validPattern(pattern: string): boolean {
  return pattern.length <= MAX_PATTERN && compile(pattern) !== undefined;
}

export function matchPattern(pattern: string, value: string, full = true): boolean {
  if (value.length > MAX_VALUE) return false;
  const compiled = compile(pattern);
  if (!compiled) return false;
  const matcher = compiled.matcher(value);
  return full ? matcher.matches() : matcher.find();
}

/** Rust-style replacement fields: $1, $name, ${name}, and $$ for a literal $. */
export function replacePattern(pattern: string, value: string, replacement: string, all = false): string | undefined {
  if (value.length > MAX_VALUE || replacement.length > MAX_VALUE) return undefined;
  const compiled = compile(pattern);
  if (!compiled) return undefined;
  const matcher = compiled.matcher(value);
  let result = "";
  let end = 0;
  while (matcher.find()) {
    result += value.slice(end, matcher.start());
    result += replacement.replace(/\$(?:\{([A-Za-z_0-9]+)\}|([A-Za-z_0-9]+)|(\$))/gu, (_, braced, plain, dollar) => {
      if (dollar) return "$";
      const field = braced ?? plain;
      try {
        return matcher.group(/^\d+$/u.test(field) ? Number(field) : field) ?? "";
      } catch {
        return "";
      }
    });
    if (result.length > MAX_OUTPUT) return undefined;
    end = matcher.end();
    if (!all) break;
  }
  result += value.slice(end);
  return result.length <= MAX_OUTPUT ? result : undefined;
}
