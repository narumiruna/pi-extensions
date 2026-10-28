import type { ColorPalette, StyledChunk } from "../../format/style.js";
import { formatCount } from "../helpers.js";
import { defineModule, type ModuleOptionValue } from "../types.js";
import { joinStatusTemplates, renderStatusTemplate } from "./status-templates.js";

const COUNT_VARIABLES = ["count"] as const;
const DEFAULT_TEMPLATES = {
  ahead: "⇡$count",
  behind: "⇣$count",
  up_to_date: "",
  diverged: "⇕⇡$ahead_count⇣$behind_count",
  conflicted: "=$count",
  stashed: "\\$$count",
  deleted: "✘$count",
  renamed: "»$count",
  modified: "!$count",
  typechanged: "T$count",
  staged: "+$count",
  untracked: "?$count",
  worktree_added: "A$count",
  worktree_deleted: "D$count",
  worktree_modified: "M$count",
  worktree_typechanged: "T$count",
  index_added: "A$count",
  index_deleted: "D$count",
  index_modified: "M$count",
  index_typechanged: "T$count",
} as const;

type StatusTemplate = keyof typeof DEFAULT_TEMPLATES;

export const gitStatusModule = defineModule({
  name: "git_status",
  variables: [
    "symbol",
    "all_status",
    "ahead_behind",
    "ahead",
    "behind",
    "up_to_date",
    "diverged",
    "conflicted",
    "stashed",
    "deleted",
    "renamed",
    "modified",
    "typechanged",
    "staged",
    "untracked",
    "worktree_added",
    "worktree_deleted",
    "worktree_modified",
    "worktree_typechanged",
    "index_added",
    "index_deleted",
    "index_modified",
    "index_typechanged",
  ],
  defaults: {
    format: "[$all_status( $ahead_behind) ]($style)",
    symbol: "",
    style: "red bold",
    disabled: false,
  },
  options: {
    ...Object.fromEntries(
      Object.entries(DEFAULT_TEMPLATES).map(([name, template]) => [
        name,
        {
          kind: "string" as const,
          default: template,
          templateVariables:
            name === "diverged" ? ["ahead_count", "behind_count"] : name === "up_to_date" ? [] : COUNT_VARIABLES,
        },
      ]),
    ),
    ignore_submodules: { kind: "boolean", default: false },
  },
  values: ({ runtime, options, palette, requestedVariables }) => {
    if (!runtime.gitBranch || !runtime.gitStatus) return undefined;
    const status = runtime.gitStatus;
    const hasAhead = Number.isSafeInteger(status.ahead) && status.ahead > 0;
    const hasBehind = Number.isSafeInteger(status.behind) && status.behind > 0;
    const template = (name: StatusTemplate, variables: Readonly<Record<string, string>>) =>
      renderStatusTemplate(templateOption(options, name), variables, palette);
    const count = (name: StatusTemplate, value: number) => countTemplate(options, name, value, palette);
    const ahead = count("ahead", status.ahead);
    const behind = count("behind", status.behind);
    const diverged =
      hasAhead && hasBehind
        ? template("diverged", { ahead_count: formatCount(status.ahead), behind_count: formatCount(status.behind) })
        : [];
    const upToDate = status.upToDate && status.ahead === 0 && status.behind === 0 ? template("up_to_date", {}) : [];
    const values = {
      ahead,
      behind,
      up_to_date: upToDate,
      diverged,
      ahead_behind: hasAhead && hasBehind ? diverged : hasAhead ? ahead : hasBehind ? behind : upToDate,
      conflicted: count("conflicted", status.conflicted),
      stashed: count("stashed", status.stashed),
      deleted: count("deleted", status.deleted),
      renamed: count("renamed", status.renamed),
      modified: count("modified", status.modified),
      typechanged: count("typechanged", status.typechanged),
      staged: count("staged", status.staged),
      untracked: count("untracked", status.untracked),
      worktree_added: count("worktree_added", status.worktreeAdded),
      worktree_deleted: count("worktree_deleted", status.worktreeDeleted),
      worktree_modified: count("worktree_modified", status.worktreeModified),
      worktree_typechanged: count("worktree_typechanged", status.worktreeTypechanged),
      index_added: count("index_added", status.indexAdded),
      index_deleted: count("index_deleted", status.indexDeleted),
      index_modified: count("index_modified", status.indexModified),
      index_typechanged: count("index_typechanged", status.indexTypechanged),
    };
    const allStatus = joinStatusTemplates([
      values.conflicted,
      values.stashed,
      values.deleted,
      values.renamed,
      values.modified,
      values.typechanged,
      values.staged,
      values.untracked,
    ]);
    const available = { ...values, all_status: allStatus };
    const requested = [...(requestedVariables ?? [])].filter((name) => Object.hasOwn(available, name));
    const visible =
      requested.length > 0
        ? requested.map((name) => available[name as keyof typeof available])
        : [allStatus, values.ahead_behind];
    return visible.some((value) => value.length > 0) ? available : undefined;
  },
});

function templateOption(options: Readonly<Record<string, ModuleOptionValue>>, name: StatusTemplate): string {
  const option = options[name];
  return typeof option === "string" ? option : DEFAULT_TEMPLATES[name];
}

function countTemplate(
  options: Readonly<Record<string, ModuleOptionValue>>,
  name: StatusTemplate,
  value: number,
  palette: ColorPalette,
): StyledChunk[] {
  return Number.isSafeInteger(value) && value > 0
    ? renderStatusTemplate(templateOption(options, name), { count: formatCount(value) }, palette)
    : [];
}
