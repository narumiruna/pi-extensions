import {
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../terminal-text.js";
import type { MenuScreen } from "../types.js";
import type { MenuChangeResponse, MenuScreenComponent, MenuScreenComponentOptions } from "./contracts.js";
import { handleSearchInput, renderFrameLayout, safeMenuText } from "./rendering.js";

export type InputOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "input" }>;
};

export function createInputComponent<ScreenId extends string, ActionId extends string>(
  options: InputOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const input = new Input();
  if (options.screen.initialValue !== undefined) initializeInputValue(input, options.screen.initialValue);
  let pending = Promise.resolve();
  let submitting = false;
  let closing = false;
  let disposed = false;
  let mouseLayout: { width: number; inputFrameRow?: number } | undefined;

  const closeAfterPending = (kind: "back" | "close") => {
    if (closing || disposed) return;
    closing = true;
    void pending.then(() => {
      if (!disposed) options.onEvent({ kind });
    });
  };
  const submit = () => {
    if (submitting || closing || disposed) return;
    submitting = true;
    const value = input.getValue();
    const operation = Promise.resolve()
      .then(async () => {
        let response: MenuChangeResponse<ScreenId> = false;
        try {
          response = (await options.onInputSubmit?.({ value })) ?? false;
        } catch (error) {
          options.onError?.(error);
        }
        if (disposed) return;
        submitting = false;
        const accepted = typeof response === "boolean" ? response : response.accepted;
        if (accepted && typeof response !== "boolean") {
          closing = true;
          options.onTransition?.(response.transition);
        }
        options.tui.requestRender();
      })
      .catch(() => {
        if (!disposed) {
          submitting = false;
          options.tui.requestRender();
        }
      });
    pending = operation;
  };

  const component: MenuScreenComponent & Focusable = {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    render(width) {
      const safeWidth = Math.max(1, width);
      const content = [
        ...input.render(safeWidth),
        ...(input.getValue().length === 0 && options.screen.placeholder
          ? wrapTextWithAnsi(options.theme.fg("dim", safeMenuText(options.screen.placeholder)), safeWidth)
          : []),
        ...(submitting ? [options.theme.fg("dim", "Saving…")] : []),
      ];
      const frame = renderFrameLayout(
        options.screen.title,
        options.screen.lines ?? [],
        content,
        options.screen.hint ?? "back",
        safeWidth,
        options,
        {
          confirmAction: "submit",
          pinnedContentRows: 1,
          priorityTailRows: submitting ? 1 : 0,
        },
      );
      mouseLayout = {
        width: safeWidth,
        inputFrameRow: frame.contentRows.find(({ contentIndex }) => contentIndex === 0)?.frameIndex,
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      input.invalidate();
    },
    handleInput(data) {
      if (disposed || closing) return;
      if (matchesKey(data, Key.ctrl("c"))) closeAfterPending("close");
      else if (options.keybindings.matches(data, "tui.select.cancel")) {
        closeAfterPending(options.screen.hint ?? "back");
      } else if (options.keybindings.matches(data, "tui.input.submit")) submit();
      else if (!submitting) handleSearchInput(input, data);
      options.tui.requestRender();
    },
    handleMouse(event): TuiMouseEventResult | undefined {
      if (
        disposed ||
        closing ||
        submitting ||
        !mouseLayout ||
        event.width !== mouseLayout.width ||
        event.y !== mouseLayout.inputFrameRow
      ) {
        return undefined;
      }
      return input.handleMouse({ ...event, y: 0, width: mouseLayout.width, height: 1 });
    },
    waitForPending: () => pending,
    dispose() {
      if (disposed) return;
      disposed = true;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
  return component;
}

function initializeInputValue(input: Input, value: string) {
  const initializer = new Input();
  handleSearchInput(initializer, `\u001b[200~${sanitizeInputInitialValue(value)}\u001b[201~`);
  const initialized = initializer.getValue();
  input.setValue(initialized);

  // Input.setValue() preserves its cursor, so use its public mouse contract to place a fresh cursor at the end.
  const x = visibleWidth(initialized) + 2;
  input.handleMouse({
    type: "press",
    button: "left",
    x,
    y: 0,
    screenX: x,
    screenY: 0,
    width: x + 1,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

function sanitizeInputInitialValue(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x1b) return " ";
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return character;
    return sanitizeTerminalText(character);
  }).join("");
}
