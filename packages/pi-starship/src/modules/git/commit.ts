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
  },
  values: ({ runtime, options }) => {
    const commit = runtime.gitCommit;
    if (!commit) return undefined;
    const hashLength =
      typeof options.commit_hash_length === "number" ? options.commit_hash_length : DEFAULT_HASH_LENGTH;
    return {
      hash: commit.hash.slice(0, hashLength),
      tag: commit.tag ? ` 🏷 ${commit.tag}` : "",
    };
  },
});
