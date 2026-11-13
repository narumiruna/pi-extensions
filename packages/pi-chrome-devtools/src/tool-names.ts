export const CORE_CHROME_DEVTOOLS_TOOL_NAMES = [
  "chrome_devtools_list_pages",
  "chrome_devtools_select_page",
  "chrome_devtools_navigate",
  "chrome_devtools_evaluate",
  "chrome_devtools_screenshot",
] as const;

export const WEBMCP_TOOL_NAMES = ["chrome_devtools_webmcp_list_tools", "chrome_devtools_webmcp_call_tool"] as const;

export const CHROME_DEVTOOLS_TOOL_NAMES = [...CORE_CHROME_DEVTOOLS_TOOL_NAMES, ...WEBMCP_TOOL_NAMES] as const;

export type ChromeDevToolsToolName = (typeof CHROME_DEVTOOLS_TOOL_NAMES)[number];
export type WebMcpToolName = (typeof WEBMCP_TOOL_NAMES)[number];

export function isWebMcpToolName(value: string): value is WebMcpToolName {
  return WEBMCP_TOOL_NAMES.includes(value as WebMcpToolName);
}
