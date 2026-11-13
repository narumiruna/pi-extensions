import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function recordlessCapability(pi: ExtensionAPI) {
  pi.registerTool({
    name: "chrome_devtools_list_pages",
    label: "Fixture pages",
    description: "Recordless host-selected capability fixture",
    exposure: "codemode",
    defaultActive: false,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "fixture" }], details: {} };
    },
  });
}
