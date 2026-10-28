import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { createMenuScreenComponent } from "../../src/components/index.js";
import type { MenuScreen } from "../../src/types.js";

export function documentKeys(copy: readonly string[] = ["ctrl+x"], overrides: Record<string, readonly string[]> = {}) {
  const keys: Record<string, readonly string[]> = {
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.pageUp": ["pageUp"],
    "tui.select.pageDown": ["pageDown"],
    "tui.select.confirm": ["enter"],
    "tui.select.cancel": ["escape", "ctrl+c"],
    "tui.altScreen.searchNext": ["enter"],
    "tui.altScreen.searchPrevious": ["shift+enter"],
    "tui.altScreen.searchClose": ["escape"],
    "app.message.copy": copy,
    ...overrides,
  };
  return {
    getKeys: (binding: string) => keys[binding] ?? [],
    matches: (data: string, binding: string) => (keys[binding] ?? []).some((key) => matchesKey(data, key as KeyId)),
  };
}

export function documentComponent(
  screen: MenuScreen<"document", "apply">,
  options: {
    keys?: ReturnType<typeof documentKeys>;
    signal?: AbortSignal;
    isCurrent?(): boolean;
    onDispose?(): void;
  } = {},
) {
  const events: unknown[] = [];
  let renders = 0;
  let rows = 24;
  const roles: string[] = [];
  const component = createMenuScreenComponent({
    screen,
    keybindings: options.keys ?? documentKeys(),
    signal: options.signal,
    isCurrent: options.isCurrent,
    onDispose: options.onDispose,
    tui: {
      terminal: {
        get rows() {
          return rows;
        },
      },
      requestRender: () => renders++,
    },
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
    onEvent: (event) => events.push(event),
  });
  return {
    component,
    events,
    roles,
    get renders() {
      return renders;
    },
    resize: (height: number) => {
      rows = height;
    },
    text: (width = 160) => component.render(width).join("\n"),
  };
}
