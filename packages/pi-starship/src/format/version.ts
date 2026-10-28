import { parseFormat, renderFormat } from "./formatter.js";
import { isFillChunk } from "./style.js";

/** Use the package format grammar, without applying ANSI styles to the version value. */
export function formatVersion(raw: string, format: string | undefined): string {
  // Collectors historically pass versions with a leading v. Keep the existing raw value.
  const version = raw.replace(/^v/u, "");
  const fallback = `v${version}`;
  const template = format ?? "v$raw";
  if (template.length > 4_096) return fallback;
  // Only dotted numeric releases and an optional prerelease/build suffix expose components.
  // Missing components stay absent; malformed releases keep only their raw value.
  const release = /^(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.+_-]+|[A-Za-z][0-9A-Za-z.+_-]*)?$/u.exec(version)?.[1];
  const parts = release?.split(".").map((part) => part.replace(/^0+(?=\d)/u, ""));
  try {
    return renderFormat(parseFormat(template), {
      variables: { raw: version, major: parts?.[0], minor: parts?.[1], patch: parts?.[2] },
    })
      .map((chunk) => (isFillChunk(chunk) ? "" : chunk.text))
      .join("");
  } catch {
    return fallback;
  }
}
