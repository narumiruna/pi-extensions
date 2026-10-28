import { defineModule } from "../types.js";

const STATE_OPTIONS: Readonly<Record<string, string>> = {
  REBASING: "rebase",
  MERGING: "merge",
  REVERTING: "revert",
  "CHERRY-PICKING": "cherry_pick",
  BISECTING: "bisect",
  AM: "am",
  "AM/REBASE": "am_or_rebase",
};

export const gitStateModule = defineModule({
  name: "git_state",
  variables: ["symbol", "state", "progress_current", "progress_total"],
  defaults: {
    format: "[ ($state( $progress_current/$progress_total)) ]($style)",
    symbol: "",
    style: "bold yellow",
    disabled: false,
  },
  options: {
    rebase: { kind: "string", default: "REBASING" },
    merge: { kind: "string", default: "MERGING" },
    revert: { kind: "string", default: "REVERTING" },
    cherry_pick: { kind: "string", default: "CHERRY-PICKING" },
    bisect: { kind: "string", default: "BISECTING" },
    am: { kind: "string", default: "AM" },
    am_or_rebase: { kind: "string", default: "AM/REBASE" },
  },
  values: ({ runtime, options }) => {
    const state = runtime.gitState;
    if (!state) return undefined;
    const key = STATE_OPTIONS[state.state];
    const label = typeof key === "string" ? options[key] : undefined;
    return {
      state: typeof label === "string" ? label : state.state,
      progress_current: state.progressCurrent?.toString() ?? "",
      progress_total: state.progressTotal?.toString() ?? "",
    };
  },
});
