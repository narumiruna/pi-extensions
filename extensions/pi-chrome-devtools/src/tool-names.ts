export const CHROME_DEVTOOLS_TOOL_NAMES = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_evaluate",
	"chrome_devtools_screenshot",
] as const;

export type ChromeDevToolsToolName = (typeof CHROME_DEVTOOLS_TOOL_NAMES)[number];
