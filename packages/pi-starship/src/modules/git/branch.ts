import { truncateLeadingGraphemes } from "../truncation.js";
import { defineModule } from "../types.js";

export const gitBranchModule = defineModule({
  name: "git_branch",
  variables: ["symbol", "branch", "remote_name", "remote_branch"],
  defaults: {
    format: "[ $symbol $branch ]($style)",
    symbol: "🌿",
    style: "bold purple",
    disabled: false,
  },
  options: {
    // Starship uses i64::MAX as its effective no-truncation default. Zero is the
    // equivalent stable TOML representation in pi-starship's bounded integer schema.
    truncation_length: { kind: "integer", default: 0, minimum: 0, maximum: 1_000_000 },
    truncation_symbol: { kind: "string", default: "…" },
  },
  values: ({ runtime, options }) => {
    const branch = runtime.gitBranchDetails;
    const name = branch?.name ?? runtime.gitBranch;
    if (!name) return undefined;
    const length = typeof options.truncation_length === "number" ? options.truncation_length : 0;
    const symbol = typeof options.truncation_symbol === "string" ? options.truncation_symbol : "…";
    return {
      branch: truncateLeadingGraphemes(name, length, symbol),
      remote_name: truncateLeadingGraphemes(branch?.remoteName ?? "", length, symbol),
      remote_branch: truncateLeadingGraphemes(branch?.remoteBranch ?? "", length, symbol),
    };
  },
});
