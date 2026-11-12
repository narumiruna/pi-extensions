import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { IllustrateSettings } from "./settings.js";
import { showIllustrateSettings } from "./settings-screen.js";

export interface IllustrateMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  getSettings(): IllustrateSettings;
  settingsPath: string;
  saveSettings(patch: Partial<IllustrateSettings>): Promise<void>;
  getStatus(): string[];
}

const help = [
  "illustrate_svg displays self-contained static SVG. illustrate_mermaid renders Mermaid locally with Pele.",
  "Both tools require Pi TUI mode and Kitty image support. They do not use a browser or a remote rendering service.",
  'cols accepts "auto" or a positive safe integer. Omission uses the user default; explicit "auto" overrides a numeric default.',
  "Auto follows the available width. Numeric widths are caps and shrink when needed. Diagrams keep their proportions and layout.",
  "Mermaid follows Pi appearance unless Settings selects dark or light. SVG keeps its own colors.",
  "sendToModel defaults to false on every call. True sends one immutable PNG snapshot to an image-capable model. There is no global preference.",
  "Session records retain bounded diagram source and an explicitly requested model snapshot. No diagram files are written into the project.",
  "SVG must be static and self-contained: no scripts, event handlers, external resources, XML entities, or browser-only content.",
];

/** Command syntax and non-TUI rejection belong to the extension integration. */
export async function showIllustrateMenu(ctx: ExtensionCommandContext, owner: IllustrateMenuOwner): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/illustrate requires Pi TUI mode.");
  if (owner.signal.aborted || !owner.isCurrent()) return;
  let settingsRequested = false;
  const menu = defineMenu<IllustrateSettings, "main" | "status" | "help", "settings">({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Illustrate",
        lines: [`Default width: ${state.defaultCols} · Mermaid appearance: ${state.mermaidAppearance}`],
        items: [
          {
            id: "settings",
            label: "Settings",
            description: "User preferences · saved immediately",
            action: "settings",
          },
          { id: "status", label: "Status", description: "Capabilities and current rendering work", to: "status" },
          { id: "help", label: "Help", description: "Tools, privacy, and static diagram limits", to: "help" },
        ],
        hint: "close",
      }),
      status: () => ({
        kind: "review",
        title: "Illustrate Status",
        content: [
          ...owner.getStatus().map((line) => sanitizeTerminalText(line)),
          `User settings: ${sanitizeTerminalText(owner.settingsPath)}`,
        ].join("\n"),
        viewportSize: "adaptive",
        hint: "back",
      }),
      help: () => ({
        kind: "review",
        title: "Illustrate Help",
        content: help.join("\n\n"),
        viewportSize: "adaptive",
        hint: "back",
      }),
    },
    actions: {
      settings: () => {
        settingsRequested = true;
        return { kind: "close" };
      },
    },
  });
  while (!owner.signal.aborted && owner.isCurrent()) {
    settingsRequested = false;
    const result = await runMenu(ctx, menu, {
      getState: () => owner.getSettings(),
      signal: owner.signal,
      isCurrent: () => owner.isCurrent(),
      onError: (_ctx, error) => {
        if (!owner.signal.aborted && owner.isCurrent()) {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Illustrate menu failed: ${sanitizeTerminalText(reason)}`, "error");
        }
      },
    });
    if (owner.signal.aborted || !owner.isCurrent() || result.kind !== "closed" || !settingsRequested) return;
    // Finish the menu owner before starting a separate native settings flow.
    const settingsResult = await showIllustrateSettings(ctx, owner);
    if (owner.signal.aborted || !owner.isCurrent() || settingsResult !== "back") return;
  }
}
