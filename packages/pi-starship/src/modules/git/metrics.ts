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
  options: {
    only_nonzero_diffs: { kind: "boolean", default: true },
    ignore_submodules: { kind: "boolean", default: false },
  },
  values: ({ runtime, options }) => {
    const metrics = runtime.gitMetrics;
    const onlyNonzero = options.only_nonzero_diffs !== false;
    if (!metrics || (onlyNonzero && metrics.added === 0 && metrics.deleted === 0)) return undefined;
    return {
      added: !onlyNonzero || metrics.added > 0 ? metrics.added.toString() : "",
      deleted: !onlyNonzero || metrics.deleted > 0 ? metrics.deleted.toString() : "",
    };
  },
});
