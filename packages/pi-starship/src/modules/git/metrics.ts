import { defineModule } from "../types.js";

export const gitMetricsModule = defineModule({
  name: "git_metrics",
  variables: ["symbol", "added", "deleted"],
  defaults: {
    format: "([+$added]($added_style) )([-$deleted]($deleted_style) )",
    symbol: "",
    style: "none",
    disabled: true,
  },
  styleDefaults: {
    added_style: "bold green",
    deleted_style: "bold red",
  },
  styleVariables: ["added_style", "deleted_style"],
  resolveStyleVariables: ({ styles }) => styles,
  values: ({ runtime }) => {
    const metrics = runtime.gitMetrics;
    if (!metrics || (metrics.added === 0 && metrics.deleted === 0)) return undefined;
    return {
      added: metrics.added > 0 ? metrics.added.toString() : "",
      deleted: metrics.deleted > 0 ? metrics.deleted.toString() : "",
    };
  },
});
