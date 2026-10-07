import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { displayText } from "./client.js";
import { EXPOSURES, type Settings } from "./settings.js";

// Pi Input wraps raw paste content. Invalid drafts use a sanitized, cursor-free,
// mouse-inert preview; the underlying draft stays intact for keyboard editing and validation.
class SettingsInput extends Input {
  override render(width: number): string[] {
    const raw = this.getValue();
    const safe = displayText(raw);
    return safe === raw ? super.render(width) : new Text(`Invalid characters: ${safe}`, 0, 0).render(width);
  }
  override handleMouse(event: TuiMouseEvent) {
    if (displayText(this.getValue()) !== this.getValue()) return undefined;
    return super.handleMouse(event);
  }
}

export async function showSettings(
  ctx: ExtensionCommandContext,
  current: () => Settings,
  save: (patch: Partial<Settings>, signal: AbortSignal) => Promise<void>,
  sessionSignal: AbortSignal,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Interactive settings require TUI mode.");
  let pending = Promise.resolve();
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const controller = new AbortController();
    let disposed = false;
    let input: Input | undefined;
    let focused = false;
    let pasting = false;
    const close = () => {
      dispose();
      done();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      sessionSignal.removeEventListener("abort", close);
      input = undefined;
    };
    const values = (key: keyof Settings) => displayText(String(current()[key]));
    const free = (key: "accountId" | "gatewayId" | "byokAlias", label: string, description: string): SettingItem => ({
      id: key,
      label,
      description,
      currentValue: values(key),
      submenu: (_value, finish) => {
        const editor = new SettingsInput();
        input = editor;
        editor.focused = focused;
        editor.setValue(current()[key]);
        const complete = (value?: string) => {
          input = undefined;
          finish(value);
        };
        editor.onSubmit = (value) => complete(value);
        editor.onEscape = () => complete();
        return editor;
      },
    });
    const items: SettingItem[] = [
      free("accountId", "Cloudflare account ID", "32-character hexadecimal account ID; user scope only."),
      free("gatewayId", "AI Gateway", "Gateway used for every search; default is default."),
      free(
        "byokAlias",
        "BYOK alias",
        "Empty uses the gateway default key or credits; an explicit alias never falls back.",
      ),
      {
        id: "exposure",
        label: "Tool exposure",
        description:
          "codemode: script calls; direct: also declared; deferred: discoverable; model-only: no scripts; hidden: unreachable.",
        currentValue: values("exposure"),
        values: [...EXPOSURES],
      },
      {
        id: "limit",
        label: "Default result limit",
        description: "Maximum results when the caller omits limit.",
        currentValue: values("limit"),
        values: Array.from({ length: 10 }, (_, i) => String(i + 1)),
      },
      {
        id: "timeoutMs",
        label: "Request timeout (ms)",
        description: "Cancel unfinished requests after this deadline; custom 1000–120000 values may be set in JSON.",
        currentValue: values("timeoutMs"),
        values: ["10000", "30000", "60000", "120000"],
      },
    ];
    const list = new SettingsList(
      items,
      8,
      getSettingsListTheme(),
      (id, value) => {
        const key = id as keyof Settings;
        const patch = { [key]: key === "limit" || key === "timeoutMs" ? Number(value) : value };
        // Work is serialized in user action order. The storage/runtime layer owns rollback.
        pending = pending.then(async () => {
          if (controller.signal.aborted) return;
          try {
            await save(patch, controller.signal);
          } catch {
            if (!disposed && !sessionSignal.aborted)
              ctx.ui.notify(
                "Settings change failed; check pi-web-search.json and the current effective value.",
                "error",
              );
          }
          if (!disposed && !sessionSignal.aborted) {
            // A save adopts the latest document, including externally edited fields.
            for (const item of items) list.updateValue(item.id, values(item.id as keyof Settings));
            tui.requestRender();
          }
        });
      },
      close,
      // Six rows remain scannable without another untrusted search-input surface.
      { enableSearch: false },
    );
    sessionSignal.addEventListener("abort", close, { once: true });
    if (sessionSignal.aborted) close();
    const container = new Container();
    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        if (input) input.focused = value;
      },
      render(width: number) {
        const heading = new Text(theme.fg("accent", theme.bold("Web Search Settings — user scope")), 0, 0);
        const token = new Text(
          theme.fg(
            "muted",
            `API token: ${current().apiToken ? "present in settings file" : "missing"}. Edit apiToken in private pi-web-search.json; tokens are never echoed here. Changes save immediately; closing does not undo saved edits.`,
          ),
          0,
          0,
        );
        // Let Pi own rendered child bounds, mouse retargeting and nested focus.
        container.clear();
        container.addChild(heading);
        container.addChild(token);
        container.addChild(list);
        return container.render(width).map((line) => truncateToWidth(line, Math.max(0, width)));
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (disposed) return;
        const pasteInput = pasting || data.includes("\u001b[200~");
        if (data.includes("\u001b[200~")) pasting = true;
        if (data.includes("\u001b[201~")) pasting = false;
        if (!pasteInput && matchesKey(data, Key.ctrl("c"))) {
          close();
          return;
        }
        // Standard actions are handled by Pi's SettingsList/Input, including configured cancellation.
        // A cancellation inside an Input closes that submenu rather than the entire settings screen.
        if (!pasteInput && !input && keybindings.matches(data, "tui.select.cancel")) {
          close();
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
      handleMouse(event) {
        if (disposed) return undefined;
        return container.handleMouse(event);
      },
      dispose,
    };
  });
  // Closing cancels unpublished edits, but committed saves and recovery must settle
  // before a caller can reload or inspect disk state.
  await pending;
}
