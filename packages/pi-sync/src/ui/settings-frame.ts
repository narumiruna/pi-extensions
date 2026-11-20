import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Adapt only public rendering/input boundaries; Kit still owns search, saves and focus. */
export function boundedSettingsUI(ctx: ExtensionCommandContext): ExtensionCommandContext["ui"] {
  return {
    ...ctx.ui,
    custom: (factory, options) =>
      ctx.ui.custom((tui, ...args) => {
        // Kit pins search before the selected setting at a one-row budget. Render its
        // smallest complete frame, then retain the active row when the real budget is smaller.
        const terminal = new Proxy(tui.terminal, {
          get: (target, key) => (key === "rows" ? Math.max(8, target.rows) : Reflect.get(target, key)),
        });
        const screenTui = new Proxy(tui, {
          get(target, key) {
            if (key === "terminal") return terminal;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const guard = <T extends Component>(component: T): T => {
          const render = component.render.bind(component);
          const handleMouse = component.handleMouse?.bind(component);
          let sourceRow = 0;
          const compact = () => tui.terminal.rows < 8;
          component.render = (width) => {
            if (width <= 0) return [];
            const lines = render(width);
            if (!compact()) return lines;
            const active = lines.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
            const search = lines.findIndex((line) => stripVTControlCharacters(line).startsWith(">"));
            sourceRow = active < 0 ? Math.max(0, search) : active;
            return lines.slice(sourceRow, sourceRow + 1);
          };
          if (handleMouse)
            component.handleMouse = (event) => {
              if (event.width <= 0 || (compact() && event.y !== 0)) return undefined;
              component.render(event.width);
              return handleMouse(compact() ? { ...event, y: event.y + sourceRow } : event);
            };
          return component;
        };
        const component = factory(screenTui, ...args);
        return component instanceof Promise ? component.then(guard) : guard(component);
      }, options),
  };
}
