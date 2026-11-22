import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { BoundedFrameContentRow } from "./bounded-frame.js";

export interface FramedSettingsMouseLayout {
  width: number;
  nativeHeight: number;
  rows: readonly BoundedFrameContentRow[];
}

export interface FramedSettingsMouseRouter {
  setLayout(layout: FramedSettingsMouseLayout): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  clear(): void;
}

export function createFramedSettingsMouseRouter(
  dispatch: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
): FramedSettingsMouseRouter {
  let layout: { width: number; nativeHeight: number; nativeRows: Map<number, number> } | undefined;
  let pressed = false;
  return {
    setLayout({ width, nativeHeight, rows }) {
      layout = {
        width,
        nativeHeight,
        nativeRows: new Map(rows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex])),
      };
    },
    handleMouse(event) {
      const leftPress = event.type === "press" && event.button === "left";
      const leftClick = event.type === "click" && event.button === "left";
      const y = layout?.nativeRows.get(event.y);
      if (
        !layout ||
        y === undefined ||
        !(y >= 0 && y < layout.nativeHeight) ||
        !(event.x >= 0 && event.x < layout.width)
      ) {
        if (leftPress || leftClick) pressed = false;
        return undefined;
      }
      const nativeEvent = { ...event, y, width: layout.width, height: layout.nativeHeight };
      if (leftClick && !pressed) dispatch({ ...nativeEvent, type: "press" });
      const result = dispatch(nativeEvent);
      if (leftPress) pressed = result?.handled === true;
      if (event.type === "click" || event.type === "wheel") pressed = false;
      return result;
    },
    clear() {
      layout = undefined;
      pressed = false;
    },
  };
}
