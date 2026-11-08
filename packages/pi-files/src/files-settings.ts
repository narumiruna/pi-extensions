import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, type SettingItem, SettingsList, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrameLayout, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { ContextService } from "./context-service.js";
import { normalizeKeyId } from "./file-context-settings.js";
import type { ScopeService } from "./scope/edit-scope.js";
import { ScopeInput } from "./scope/input.js";

/** Edit the two retained settings stores without changing context or edit permission. */
export async function showFilesSettings(
  ctx: ExtensionCommandContext,
  context: ContextService,
  scope: ScopeService,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Files settings require Pi TUI mode");

  const ownerSignal = AbortSignal.any([context.signal(ctx), scope.signal(ctx), ...(ctx.signal ? [ctx.signal] : [])]);
  if (ownerSignal.aborted) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([ownerSignal, controller.signal]);
  let pending = Promise.resolve();
  let shortcut = context.getState(ctx).shortcut;
  let hidden = scope.getSettings(ctx).showHiddenFiles;
  let requestedHidden = hidden;
  let hiddenSaves = 0;
  let shortcutSaving = false;
  let accepting = true;
  let dispose: (() => void) | undefined;
  let resolveDisposal!: (reload: boolean) => void;
  const disposal = new Promise<boolean>((resolve) => {
    resolveDisposal = resolve;
  });
  let redraw = () => {};
  const live = () => !signal.aborted;
  const notify = (message: string, type: "warning" | "error") => {
    if (live()) ctx.ui.notify(sanitizeTerminalText(message), type);
  };
  const shortcutBlock = (): string | undefined => {
    const state = context.getState(ctx);
    if (state.settingsInvalidReason) {
      return `Repair ${sanitizeTerminalText(state.settingsPath)} first: ${sanitizeTerminalText(state.settingsInvalidReason)}`;
    }
    if (state.quotes.length) return "Submit or remove queued context before changing the shortcut.";
    if (shortcutSaving) return "Saving the shortcut…";
    return undefined;
  };
  // Every action joins one queue. A rejected store write cannot poison later actions.
  const enqueue = (save: () => Promise<void>) => {
    pending = pending.then(async () => {
      if (!live()) return;
      try {
        await save();
      } catch (error) {
        notify(`Could not save Files settings; the previous value remains: ${errorMessage(error)}`, "error");
      }
    });
  };

  let reload = false;
  try {
    const interaction = ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
      let ended = false;
      let focused = false;
      let editor: ScopeInput | undefined;
      let submenuDone: (() => void) | undefined;
      let mouseRows = new Map<number, number>();
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      // Keep native SettingsList styling and use the callback theme, including after invalidation.
      const listTheme = getSettingsListTheme();
      listTheme.label = (text, selected) => (selected ? theme.fg("accent", text) : text);
      listTheme.value = (text, selected) => theme.fg(selected ? "accent" : "muted", text);
      listTheme.description = (text) => theme.fg("dim", text);
      listTheme.hint = (text) => theme.fg("dim", text);
      const release = () => {
        if (ended) return false;
        ended = true;
        accepting = false;
        focused = false;
        if (editor) editor.input.focused = false;
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        return true;
      };
      const finish = (shouldReload: boolean) => {
        if (release()) done(shouldReload);
      };
      const onAbort = () => finish(false);
      dispose = () => {
        // Pi resets its live dialog array through dispose(). Do not call done():
        // it would splice that array and restore a draft from the previous session.
        if (release()) resolveDisposal(false);
      };
      redraw = () => {
        if (live() && !ended) tui.requestRender();
      };
      const leaveSubmenu = () => {
        if (editor) editor.input.focused = false;
        editor = undefined;
        const complete = submenuDone;
        submenuDone = undefined;
        complete?.();
      };
      const openShortcut: NonNullable<SettingItem["submenu"]> = (_value, complete) => {
        submenuDone = () => complete();
        const input = new ScopeInput(shortcut ?? "", (text) => theme.fg("muted", text));
        editor = input;
        input.input.focused = focused;
        input.input.onEscape = leaveSubmenu;
        input.input.onSubmit = (value) => {
          if (!accepting || !live()) return;
          const blocked = shortcutBlock();
          if (blocked) {
            notify(blocked, "warning");
            return;
          }
          const raw = value.trim();
          const normalized = raw ? normalizeKeyId(raw) : null;
          if (normalized === undefined) {
            notify("Invalid Pi key identifier. Use a value such as ctrl+shift+x or f8.", "warning");
            return;
          }
          leaveSubmenu();
          if (normalized === shortcut) return;
          shortcutSaving = true;
          enqueue(async () => {
            try {
              // Context can change while an earlier hidden-file save is pending.
              const state = context.getState(ctx);
              if (state.quotes.length || state.settingsInvalidReason) {
                throw new Error(
                  "Submit or remove queued context and repair invalid context settings before changing the shortcut",
                );
              }
              await context.saveShortcut(ctx, normalized, signal);
              if (!live()) return;
              shortcut = normalized;
              accepting = false;
              // Drain all already accepted saves before closing and reloading Pi.
              void pending.then(() => {
                if (live()) finish(true);
              });
            } finally {
              shortcutSaving = false;
              redraw();
            }
          });
        };
        return {
          render(width) {
            return [
              theme.fg("accent", "Open shortcut"),
              ...input.render(width),
              theme.fg("dim", "Use a Pi key identifier. An empty value disables the shortcut."),
            ];
          },
          invalidate: () => input.input.invalidate(),
          handleInput(data) {
            input.handleInput(data, (key) => {
              if (matchesKey(key, "ctrl+c")) {
                finish(false);
                return true;
              }
              // Input owns configured cancellation, editing, and submission priority.
              return false;
            });
          },
          handleMouse(event) {
            return event.y === 1 ? input.handleMouse({ ...event, y: 0 }) : undefined;
          },
        };
      };
      const items: SettingItem[] = [
        { id: "shortcut", label: "Open shortcut", currentValue: shortcut ?? "disabled" },
        {
          id: "hidden",
          label: "Show hidden files",
          description: "Include hidden files in the edit-scope picker. Applies immediately.",
          currentValue: String(hidden),
          values: ["false", "true"],
        },
      ];
      const list = new SettingsList(
        items,
        items.length,
        listTheme,
        (id) => {
          if (id !== "hidden") return;
          // Native toggles are synchronous. Display only durable values while retaining
          // each requested toggle separately, including rapid toggles during a write.
          list.updateValue("hidden", String(hidden));
          if (!accepting || !live()) return;
          requestedHidden = !requestedHidden;
          const value = requestedHidden;
          hiddenSaves += 1;
          enqueue(async () => {
            try {
              await scope.saveShowHiddenFiles(ctx, value);
              if (!live()) return;
              hidden = value;
            } finally {
              hiddenSaves -= 1;
              if (!hiddenSaves) requestedHidden = hidden;
              redraw();
            }
          });
        },
        () => finish(false),
      );
      const component: Focusable & {
        capturesViewportInput: boolean;
        render(width: number): string[];
        invalidate(): void;
        handleInput(data: string): void;
        handleMouse(event: TuiMouseEvent): ReturnType<SettingsList["handleMouse"]>;
        dispose(): void;
      } = {
        capturesViewportInput: true,
        get focused() {
          return focused;
        },
        set focused(value) {
          focused = value;
          if (editor) editor.input.focused = value;
        },
        render(width) {
          if (!live()) return [];
          const renderWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          const blocked = shortcutBlock();
          const shortcutItem = items[0];
          if (shortcutItem) {
            shortcutItem.description = blocked ?? "Open the context browser. Saving reloads Pi.";
            shortcutItem.submenu = blocked ? undefined : openShortcut;
          }
          list.updateValue("shortcut", shortcut ?? "disabled");
          list.updateValue("hidden", String(hidden));
          listTheme.cursor = theme.fg("accent", "→ ");
          // Native hints contain fixed Enter/Escape labels. Omit them rather than
          // advertise keys that can be remapped. Native input dispatch is unchanged.
          // Keep the native cursor marker measurable in narrow lists. Inputs must
          // receive their actual width so horizontal scrolling retains the IME cursor.
          const native = list.render(editor ? renderWidth : Math.max(8, renderWidth));
          const content = editor ? native : native.slice(0, -2);
          const focusedRow = editor ? 1 : content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const layout = renderBoundedFrameLayout({
            width: renderWidth,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(renderWidth)[0] ?? "",
            title: [theme.fg("accent", theme.bold("Files Settings"))],
            content,
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
          mouseRows = new Map(layout.contentRows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex]));
          return layout.lines;
        },
        invalidate() {
          rule.invalidate();
          list.invalidate();
        },
        handleInput(data) {
          if (!live()) return;
          if (editor) list.handleInput(data);
          else if (matchesKey(data, "ctrl+c")) finish(false);
          else if (accepting) list.handleInput(data);
          else if (keybindings.matches(data, "tui.select.cancel")) finish(false);
          redraw();
        },
        handleMouse(event) {
          if (!live() || !accepting) return undefined;
          const row = mouseRows.get(event.y);
          if (row === undefined) return undefined;
          const result = list.handleMouse({ ...event, y: row });
          redraw();
          return result;
        },
        dispose,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) finish(false);
      return component;
    });
    // Host reset can leave custom() pending. Release this flow independently.
    reload = await Promise.race([interaction, disposal]);
  } finally {
    dispose?.();
    controller.abort();
    // A hidden-file write cannot be interrupted through the service API. Do not
    // let command completion, session replacement, or shutdown race its durability.
    await pending;
  }
  if (!reload || ownerSignal.aborted) return;
  if (context.getState(ctx).quotes.length) {
    ctx.ui.notify("The shortcut was saved. Submit or remove queued context, then run /reload to apply it.", "warning");
    return;
  }
  try {
    await ctx.reload();
    return;
  } catch (error) {
    if (ownerSignal.aborted) return;
    ctx.ui.notify(
      sanitizeTerminalText(
        `The shortcut was saved, but Pi could not reload. Run /reload to apply it: ${errorMessage(error)}`,
      ),
      "error",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
