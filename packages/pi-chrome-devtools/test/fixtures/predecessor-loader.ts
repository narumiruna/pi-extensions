import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ChromeDevToolsToolName, CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../../src/tool-names.js";

// Minimal activation-only fixture for the d7ac9cb6 predecessor. Actual package
// upgrade probes independently verify both branches; browser execution is stubbed.
// The predecessor activates its loader by registration, uses direct capabilities,
// and has no activation-provenance store.
export default function predecessor(pi: ExtensionAPI) {
  let available: readonly ChromeDevToolsToolName[] = [];
  for (const name of names) {
    pi.registerTool(
      defineTool({
        name,
        label: name,
        description: "Predecessor browser capability",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "stub" }], details: {} };
        },
      }),
    );
  }
  pi.registerTool(
    defineTool({
      name: "chrome_devtools_load",
      label: "Chrome DevTools: Load Tools",
      description: "Find and enable browser tools",
      promptSnippet: "Load Chrome DevTools browser capabilities on demand",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
      async execute() {
        const matches = available.slice(0, 1);
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...matches])]);
        return { content: [{ type: "text", text: matches.join(", ") }], details: { matches } };
      },
    }),
  );
  pi.on("session_start", (_event, ctx) => {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "pi-chrome-devtools.json"), "utf8"));
    available = Array.isArray(settings.tools) ? names.filter((name) => settings.tools.includes(name)) : names;
    const compat = ctx.model?.compat;
    const native =
      ctx.model?.api === "openai-responses" &&
      compat !== undefined &&
      "supportsToolSearch" in compat &&
      compat.supportsToolSearch === true;
    const other = pi.getActiveTools().filter((name) => !names.includes(name as never));
    pi.setActiveTools([...other, ...(native ? [] : available)]);
  });
}
