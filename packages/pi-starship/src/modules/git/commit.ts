import { defineModule } from "../types.js";

const DEFAULT_HASH_LENGTH = 7;

export const gitCommitModule = defineModule({
  name: "git_commit",
  variables: ["symbol", "hash", "tag"],
  defaults: {
    format: "[ ($hash) ]($style)",
    symbol: "",
    style: "green bold",
    disabled: false,
  },
  options: {
    commit_hash_length: { kind: "integer", default: DEFAULT_HASH_LENGTH, minimum: 0, maximum: 64 },
    only_detached: { kind: "boolean", default: false },
    tag_symbol: { kind: "string", default: " 🏷 " },
    tag_disabled: { kind: "boolean", default: false },
    tag_max_candidates: { kind: "integer", default: 0, minimum: 0, maximum: 100 },
  },
  values: ({ runtime, options }) => {
    const commit = runtime.gitCommit;
    if (!commit || (options.only_detached === true && !commit.detached)) return undefined;
    const hashLength =
      typeof options.commit_hash_length === "number" ? options.commit_hash_length : DEFAULT_HASH_LENGTH;
    return {
      hash: commit.hash.slice(0, hashLength),
      tag:
        commit.tag && options.tag_disabled !== true
          ? `${typeof options.tag_symbol === "string" ? options.tag_symbol : " 🏷 "}${commit.tag}`
          : "",
    };
  },
});
