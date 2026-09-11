export const YOUCOM_TOOL_NAMES = ["youcom_search", "youcom_contents"] as const;

export type YoucomToolName = (typeof YOUCOM_TOOL_NAMES)[number];
