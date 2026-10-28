import { basename, dirname, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext, SourceInfo, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";

export const ACTIVE_TOOL_WIDGET_KEY = "tool:active-tools";
export const ACTIVE_TOOL_REFRESH_INTERVAL_MS = 500;
const MAX_TOOL_NAME_LENGTH = 32;

export interface ActiveToolStatusController {
  start(ctx: ExtensionContext, enabled: boolean): void;
  setEnabled(ctx: ExtensionContext, enabled: boolean): void;
  refresh(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): void;
  isEnabled(): boolean;
}

export function createActiveToolStatusController(pi: ExtensionAPI): ActiveToolStatusController {
  let activeContext: ExtensionContext | undefined;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let enabled = false;
  let publishedValue: string | undefined;
  let hasPublished = false;

  const ownsSession = (ctx: ExtensionContext) => ctx.sessionManager === activeSession;

  const stopRefreshing = (): void => {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const clear = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget(ACTIVE_TOOL_WIDGET_KEY, undefined);
    publishedValue = undefined;
    hasPublished = false;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!enabled || !ctx.hasUI || !ownsSession(ctx)) return;
    const content = formatActiveToolWidget(pi.getActiveTools(), pi.getAllTools());
    const value = content?.join("\n");
    if (hasPublished && value === publishedValue) return;
    if (content && ctx.mode === "tui") {
      ctx.ui.setWidget(ACTIVE_TOOL_WIDGET_KEY, (_tui, theme) => createActiveToolWidget(content, theme), {
        placement: "aboveEditor",
      });
    } else {
      ctx.ui.setWidget(ACTIVE_TOOL_WIDGET_KEY, content, { placement: "aboveEditor" });
    }
    publishedValue = value;
    hasPublished = true;
  };

  const startRefreshing = (ctx: ExtensionContext): void => {
    stopRefreshing();
    if (!enabled || !ctx.hasUI) return;
    refreshTimer = setInterval(() => {
      if (ownsSession(ctx)) publish(ctx);
    }, ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  };

  return {
    start(ctx, nextEnabled) {
      stopRefreshing();
      if (activeContext) clear(activeContext);
      activeContext = ctx;
      activeSession = ctx.sessionManager;
      enabled = nextEnabled;
      publishedValue = undefined;
      hasPublished = false;
      if (!enabled) return;
      publish(ctx);
      startRefreshing(ctx);
    },
    setEnabled(ctx, nextEnabled) {
      if (!ownsSession(ctx) || enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (!enabled) {
        stopRefreshing();
        clear(ctx);
        return;
      }
      publish(ctx);
      startRefreshing(ctx);
    },
    refresh(ctx) {
      publish(ctx);
    },
    shutdown(ctx) {
      if (!ownsSession(ctx)) return;
      stopRefreshing();
      clear(ctx);
      activeContext = undefined;
      activeSession = undefined;
      enabled = false;
    },
    isEnabled() {
      return enabled;
    },
  };
}

export function formatActiveToolWidget(
  toolNames: Iterable<string>,
  configuredTools: readonly ToolInfo[],
): string[] | undefined {
  const metadata = new Map(configuredTools.map((tool) => [tool.name, tool]));
  const names = new Set(toolNames);
  for (const tool of configuredTools) {
    // Pi maps MCP codemode exposure to deferred; both are callable without activation.
    if (tool.exposure === "codemode" || tool.exposure === "deferred") names.add(tool.name);
  }
  const mcpNamespaces = new Map<string | undefined, number>();
  const extensions = new Map<
    string | undefined,
    { label: string; count: number; codemode: number; deferred: number }
  >();
  const groups: Record<"Built-in" | "MCP" | "Extension", string[]> = {
    "Built-in": [],
    MCP: [],
    Extension: [],
  };
  for (const name of names) {
    const tool = metadata.get(name);
    if (tool?.exposure === "hidden") continue;
    const group =
      tool?.sourceInfo.path === "builtin:mcp" || tool?.namespace?.name.startsWith("mcp__")
        ? "MCP"
        : tool?.sourceInfo.source === "builtin"
          ? "Built-in"
          : "Extension";
    if (group === "MCP") {
      const namespace = tool?.namespace?.name;
      mcpNamespaces.set(namespace, (mcpNamespaces.get(namespace) ?? 0) + 1);
    }
    if (group === "Extension") {
      const source = tool?.sourceInfo;
      const key = source?.source === "sdk" ? "sdk" : source ? `path:${source.path}` : undefined;
      const summary = extensions.get(key) ?? { label: extensionLabel(source), count: 0, codemode: 0, deferred: 0 };
      summary.count += 1;
      if (tool?.exposure === "codemode" || tool?.exposure === "deferred") summary[tool.exposure] += 1;
      extensions.set(key, summary);
    }
    const marker = tool?.exposure === "codemode" || tool?.exposure === "deferred" ? ` [${tool.exposure}]` : "";
    groups[group].push(`${sanitizeToolName(name)}${marker}`);
  }
  const count = Object.values(groups).reduce((total, tools) => total + tools.length, 0);
  if (count === 0) return undefined;
  return [
    `Tools (${count})`,
    ...Object.entries(groups).flatMap(([group, tools]) => {
      const labels =
        group === "MCP"
          ? [...mcpNamespaces].map(([namespace, count]) => {
              const label = namespace ? sanitizeToolName(namespace).replace(/^mcp__/, "") || "Other" : "Other";
              return `${label} (${count})`;
            })
          : group === "Extension"
            ? [...extensions.values()].map(({ label, count, codemode, deferred }) =>
                [
                  `${label} (${count})`,
                  ...(codemode > 0 ? [`[codemode: ${codemode}]`] : []),
                  ...(deferred > 0 ? [`[deferred: ${deferred}]`] : []),
                ].join(" "),
              )
            : tools;
      return tools.length > 0 ? [`${group} (${tools.length}): ${labels.join(" · ")}`] : [];
    }),
  ];
}

function extensionLabel(source: SourceInfo | undefined): string {
  if (!source) return "Other";
  if (source.source === "sdk") return "SDK";
  const safeSource = stripTerminalSequences(source.source).replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (safeSource.startsWith("npm:")) {
    const name = safeSource.slice(4).split("/").at(-1)?.split("@")[0];
    return name ? sanitizeToolName(name) : "Other";
  }
  const safePath = stripTerminalSequences(source.path).replace(/[\p{Cc}\p{Cf}]/gu, "");
  let label = basename(safePath, extname(safePath));
  if (label === "index") {
    let directory = dirname(safePath);
    if (basename(directory) === "src" || basename(directory) === "dist") directory = dirname(directory);
    label = basename(directory);
  }
  return label ? sanitizeToolName(label) : "Other";
}

export function renderActiveToolWidget(lines: readonly string[], theme: Theme, width: number): string[] {
  return createActiveToolWidget(lines, theme).render(width);
}

function createActiveToolWidget(lines: readonly string[], theme: Theme): EditorStatusWidget {
  // Kit normalizes fractional and invalid widths and clips wrapped glyphs wider than the row.
  return new EditorStatusWidget({
    theme,
    renderBody: (width) => (width === 0 ? lines.map(() => "") : lines.flatMap((line) => wrapTextWithAnsi(line, width))),
  });
}

export function sanitizeToolName(value: string): string {
  const printable = stripTerminalSequences(value).replace(/[^\p{L}\p{N}_.:/-]+/gu, "");
  if (!printable) return "tool";
  const characters = [...printable];
  return characters.length > MAX_TOOL_NAME_LENGTH
    ? `${characters.slice(0, MAX_TOOL_NAME_LENGTH).join("")}…`
    : printable;
}
