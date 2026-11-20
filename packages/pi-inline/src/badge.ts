import { createHash } from "node:crypto";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  type Color,
  colorToRgb,
  foregroundAnsi,
  getCapabilities,
  hyperlink,
  rgbColor,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

const palette: readonly ThemeColor[] = [
  "accent",
  "mdLink",
  "success",
  "mdHeading",
  "error",
  "syntaxString",
  "syntaxVariable",
  "thinkingXhigh",
];

function textColorForFill(fill: Color): Color {
  // Compare black and white against the fill's relative luminance (WCAG 2.2).
  const { r, g, b } = colorToRgb(fill);
  const linear = (channel: number) => {
    const srgb = Math.round(channel) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const channel = blackContrast >= whiteContrast ? 0 : 255;
  return rgbColor(channel, channel, channel);
}

export function cleanBadgeLabel(label: string): string {
  return stripTerminalSequences(label)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
    .trim();
}

/** Renders a badge as ANSI text with an optional terminal link or hover target. */
export function renderBadge(
  label: string,
  theme: Theme,
  userMessage: boolean,
  href?: string,
  groupId?: string,
): string {
  const caps = getCapabilities();
  const mode = caps.trueColor ? "truecolor" : "256color";
  const key = createHash("sha256").update(label.normalize("NFC")).digest()[0];
  const fill = theme.colors[palette[key % palette.length]];
  const edge = foregroundAnsi(fill, mode);
  const body = backgroundAnsi(fill, mode) + foregroundAnsi(textColorForFill(fill), mode);
  const resetFill = (userMessage && theme.getBgAnsi("userMessageBg")) || "\x1b[49m";
  const padded = `\u00a0${label.replaceAll(" ", "\u00a0")}\u00a0`;
  // Rounded Powerline caps require glyph support from the terminal or its font.
  const badge = `${edge}\uE0B6${body}${padded}${resetFill}${edge}\uE0B4\x1b[39m`;
  if (!caps.hyperlinks) return badge;
  // An empty group URL allows a preview without a click destination.
  if (groupId) return `\x1b]8;id=${groupId};${href ?? ""}\x1b\\${badge}\x1b]8;;\x1b\\`;
  return href ? hyperlink(badge, href) : badge;
}
