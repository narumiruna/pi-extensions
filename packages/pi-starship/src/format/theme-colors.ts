import type { Theme, ThemeToken } from "@earendil-works/pi-coding-agent";

export type ThemeColors = Theme["colors"];

// Pi exports ThemeToken as a type, but has no public runtime token registry.
// Exhaustiveness keeps validation aligned with the installed public API without
// reading the active theme before Pi initializes it.
const THEME_ROLES = {
  accent: true,
  border: true,
  borderAccent: true,
  borderMuted: true,
  success: true,
  error: true,
  warning: true,
  muted: true,
  dim: true,
  text: true,
  thinkingText: true,
  scrollbarTrack: true,
  scrollbarThumb: true,
  selectedBg: true,
  searchMatchBg: true,
  searchMatchText: true,
  userMessageBg: true,
  userMessageText: true,
  customMessageBg: true,
  customMessageText: true,
  customMessageLabel: true,
  toolPendingBg: true,
  toolSuccessBg: true,
  toolErrorBg: true,
  toolTitle: true,
  toolOutput: true,
  mdHeading: true,
  mdLink: true,
  mdLinkUrl: true,
  mdCode: true,
  mdCodeBlock: true,
  mdCodeBlockBorder: true,
  mdQuote: true,
  mdQuoteBorder: true,
  mdHr: true,
  mdListBullet: true,
  toolDiffAdded: true,
  toolDiffRemoved: true,
  toolDiffContext: true,
  syntaxComment: true,
  syntaxKeyword: true,
  syntaxFunction: true,
  syntaxVariable: true,
  syntaxString: true,
  syntaxNumber: true,
  syntaxType: true,
  syntaxOperator: true,
  syntaxPunctuation: true,
  thinkingOff: true,
  thinkingMinimal: true,
  thinkingLow: true,
  thinkingMedium: true,
  thinkingHigh: true,
  thinkingXhigh: true,
  thinkingMax: true,
  bashMode: true,
} satisfies Record<ThemeToken, true>;

export function isThemeRole(role: string): role is ThemeToken {
  return Object.hasOwn(THEME_ROLES, role);
}
