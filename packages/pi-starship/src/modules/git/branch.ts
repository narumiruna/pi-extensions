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
    only_attached: { kind: "boolean", default: false },
    // Pi formats historically expose both remote fields even for equal branches.
    always_show_remote: { kind: "boolean", default: true },
    ignore_branches: { kind: "string-array", default: [] },
    ignore_remotes: { kind: "string-array", default: [] },
    // The existing status collector does not expose bare repositories.
    ignore_bare_repo: { kind: "boolean", default: true },
  },
  values: ({ runtime, options }) => {
    const branch = runtime.gitBranchDetails;
    const name = branch?.name ?? runtime.gitBranch;
    if (!name || (options.only_attached === true && branch?.detached)) return undefined;
    if (options.ignore_bare_repo !== false && branch?.bare) return undefined;
    if (Array.isArray(options.ignore_branches) && options.ignore_branches.includes(name)) return undefined;
    const length = typeof options.truncation_length === "number" ? options.truncation_length : 0;
    const symbol = typeof options.truncation_symbol === "string" ? options.truncation_symbol : "…";
    const truncatedName = truncateLeadingGraphemes(name, length, symbol);
    const remoteBranch = truncateLeadingGraphemes(branch?.remoteBranch ?? "", length, symbol);
    const showRemote = options.always_show_remote !== false || (remoteBranch !== "" && remoteBranch !== truncatedName);
    const ignoreRemote =
      Array.isArray(options.ignore_remotes) && options.ignore_remotes.includes(branch?.remoteName ?? "");
    return {
      branch: truncatedName,
      remote_name:
        showRemote && !ignoreRemote ? truncateLeadingGraphemes(branch?.remoteName ?? "", length, symbol) : "",
      remote_branch: showRemote ? remoteBranch : "",
    };
  },
});
