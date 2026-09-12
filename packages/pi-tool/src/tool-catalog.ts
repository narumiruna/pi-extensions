import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";

export interface ToolCatalogState {
  tools: ReturnType<ExtensionAPI["getAllTools"]>;
  activeToolNames: readonly string[];
  toolSnippets: Readonly<Record<string, string>>;
}

export interface ToolCatalogItem {
  id: string;
  label: string;
  statusText: "active" | "inactive";
  description: string;
  searchText: string;
  detailContent: string;
}

export interface ToolCatalog {
  title: string;
  items: ToolCatalogItem[];
}

export function createToolCatalog(
  tools: ToolCatalogState["tools"],
  activeToolNames: readonly string[],
  toolSnippets: ToolCatalogState["toolSnippets"],
): ToolCatalog {
  const active = new Set(activeToolNames);
  const items = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool): ToolCatalogItem => {
      const parameterSchema = JSON.stringify(tool.parameters, null, 2) ?? "Unavailable";
      const guidelines = tool.promptGuidelines ?? [];
      const effectivePromptSnippet = toolSnippets[tool.name];
      return {
        id: tool.name,
        label: tool.name,
        statusText: active.has(tool.name) ? "active" : "inactive",
        description: tool.description,
        searchText: [
          tool.name,
          tool.description,
          tool.sourceInfo.source,
          tool.sourceInfo.scope,
          tool.sourceInfo.origin,
          tool.sourceInfo.path,
          tool.sourceInfo.baseDir,
          effectivePromptSnippet,
          ...guidelines,
          parameterSchema,
        ]
          .filter(Boolean)
          .join(" "),
        detailContent: [
          `Status: ${active.has(tool.name) ? "active" : "inactive"}`,
          tool.description,
          `Source: ${tool.sourceInfo.source}`,
          `Scope: ${tool.sourceInfo.scope}`,
          `Origin: ${tool.sourceInfo.origin}`,
          `Path: ${tool.sourceInfo.path}`,
          ...(tool.sourceInfo.baseDir ? [`Base directory: ${tool.sourceInfo.baseDir}`] : []),
          "",
          "Effective prompt snippet",
          effectivePromptSnippet ?? "None in the current system prompt.",
          "",
          "Parameter schema",
          parameterSchema,
          "",
          "Prompt guidelines",
          ...(guidelines.length > 0 ? guidelines.map((guideline) => `• ${guideline}`) : ["None"]),
        ].join("\n"),
      };
    });
  const activeCount = tools.reduce((count, tool) => count + Number(active.has(tool.name)), 0);
  return { title: `Tools · ${activeCount}/${tools.length} active`, items };
}

type ToolMenuScreen = "main" | "tools" | "status" | "help";
type ToolMenuAction = "toggleActiveToolStatus";

export interface ToolMenuOptions {
  settingsPath: string;
  isActiveToolStatusEnabled(): boolean;
  toggleActiveToolStatus(ctx: ExtensionCommandContext, enabled: boolean): Promise<boolean>;
}

export function createToolMenu(
  catalog: ToolCatalog,
  options: ToolMenuOptions,
): MenuDefinition<undefined, ToolMenuScreen, ToolMenuAction> {
  return {
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Tools",
        lines: [catalog.title, `Active tool status: ${options.isActiveToolStatusEnabled() ? "on" : "off"}`],
        items: [
          { id: "tools", label: "Browse tools", to: "tools" },
          {
            id: "active-tool-status",
            label: `Active tool status: ${options.isActiveToolStatusEnabled() ? "On" : "Off"}`,
            description: "Show or hide active tools above the editor",
            action: "toggleActiveToolStatus",
          },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      tools: () => ({
        kind: "browse",
        title: catalog.title,
        items: catalog.items.map((item) => ({
          id: item.id,
          label: item.label,
          statusText: item.statusText,
          description: item.description,
          searchText: item.searchText,
          detailDocument: {
            content: item.detailContent,
            format: { kind: "text" },
          },
        })),
        viewportSize: "adaptive",
        hint: "back",
      }),
      status: () => ({
        kind: "detail",
        title: "Tool Status",
        lines: [
          catalog.title,
          `Active tool status: ${options.isActiveToolStatusEnabled() ? "on" : "off"}`,
          `Settings file: ${options.settingsPath}`,
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Tool Help",
        lines: [
          "Browse tools to inspect their metadata and schemas.",
          "Toggle Active tool status from the main /tool menu.",
          "Manual pi-tool.json changes apply after /reload or the next session start.",
        ],
        hint: "back",
      }),
    },
    actions: {
      toggleActiveToolStatus: async ({ ctx }) => {
        const enabled = !options.isActiveToolStatusEnabled();
        return (await options.toggleActiveToolStatus(ctx, enabled)) ? { kind: "stay" } : { kind: "rejected" };
      },
    },
  };
}
