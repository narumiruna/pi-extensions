import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { FormatValue } from "../format/formatter.js";
import { type LayoutChunk, parseStyle } from "../format/style.js";
import { renderStatusTemplate } from "./git/status-templates.js";
import { truncateLeadingGraphemes } from "./truncation.js";
import { defineModule, type ModuleValueContext } from "./types.js";
import { workspaceModuleValues } from "./workspace-helpers.js";

export const jjBookmarkModule = defineModule({
  name: "jj_bookmark",
  variables: ["symbol", "bookmark", "remote", "diverged", "overflow_count"],
  defaults: {
    format: "on [$symbol$bookmark(@$remote)$diverged( \\(+$overflow_count others\\))]($style) ",
    symbol: " ",
    style: "bold purple",
    disabled: true,
  },
  options: {
    truncation_length: { kind: "integer", default: 65_535, minimum: 0, maximum: 65_535 },
    truncation_symbol: { kind: "string", default: "…", allowEmpty: true },
    diverged_symbol: { kind: "string", default: "*", allowEmpty: true },
    ignore_names: { kind: "string-array", default: [] },
    ignore_remotes: { kind: "string-array", default: [] },
  },
  values(context) {
    const values = workspaceModuleValues("jj_bookmark", context);
    if (!values?.bookmarks) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(values.bookmarks);
    } catch {
      return undefined;
    }
    if (!Array.isArray(raw)) return undefined;
    const parsed = raw.map(parseBookmark);
    if (parsed.some((bookmark) => bookmark === undefined)) return undefined;
    const ignoredNames = stringList(context, "ignore_names");
    const ignoredRemotes = stringList(context, "ignore_remotes");
    const bookmarks = parsed
      .filter((bookmark): bookmark is NonNullable<typeof bookmark> => bookmark !== undefined)
      .filter(
        ({ name, remote }) =>
          !ignoredNames.includes(name) && (remote === undefined || !ignoredRemotes.includes(remote)),
      );
    const bookmark = bookmarks[0];
    if (!bookmark) return undefined;
    const length = integerOption(context, "truncation_length", 65_535);
    const symbol = stringOption(context, "truncation_symbol", "…");
    const truncate = (value: string) => truncateLeadingGraphemes(value, length, symbol);
    return {
      bookmark: truncate(bookmark.name),
      remote: bookmark.remote === undefined ? "" : truncate(bookmark.remote),
      diverged: bookmark.diverged ? stringOption(context, "diverged_symbol", "*") : "",
      overflow_count: bookmarks.length > 1 ? String(bookmarks.length - 1) : "",
    };
  },
});

export const jjChangeModule = defineModule({
  name: "jj_change",
  variables: ["change", "commit", "change_prefix", "change_suffix", "change_offset", "commit_prefix", "commit_suffix"],
  defaults: { format: "$change ", symbol: "", style: "none", disabled: true },
  styleDefaults: { prefix_style: "green bold", suffix_style: "dimmed", change_offset_style: "bold" },
  styleVariables: ["prefix_style", "suffix_style", "change_offset_style"],
  resolveStyleVariables: ({ styles }) => styles,
  options: {
    change_hash_length: { kind: "integer", default: 7, minimum: 0, maximum: 255 },
    commit_hash_length: { kind: "integer", default: 7, minimum: 0, maximum: 255 },
  },
  values(context) {
    const values = workspaceModuleValues("jj_change", context);
    if (!values) return undefined;
    const change = idParts(
      values.change_id ?? "",
      Number(values.change_prefix_len),
      integerOption(context, "change_hash_length", 7),
    );
    const commit = idParts(
      values.commit_id ?? "",
      Number(values.commit_prefix_len),
      integerOption(context, "commit_hash_length", 7),
    );
    const styled = (text: string, role: string): LayoutChunk => ({
      text,
      style: parseStyle(context.styles?.[role] ?? "", context.palette),
    });
    const changeChunks = [styled(change.prefix, "prefix_style"), styled(change.suffix, "suffix_style")];
    if (values.change_offset !== undefined)
      changeChunks.push(styled(`/${values.change_offset}`, "change_offset_style"));
    return {
      change: changeChunks,
      commit: [styled(commit.prefix, "prefix_style"), styled(commit.suffix, "suffix_style")],
      change_prefix: change.prefix,
      change_suffix: change.suffix,
      change_offset: values.change_offset ?? "",
      commit_prefix: commit.prefix,
      commit_suffix: commit.suffix,
    };
  },
});

export const jjMetricsModule = defineModule({
  name: "jj_metrics",
  variables: ["added", "deleted"],
  defaults: {
    format: "([+$added]($added_style) )([-$deleted]($deleted_style) )",
    symbol: "",
    style: "none",
    disabled: true,
  },
  styleDefaults: { added_style: "bold green", deleted_style: "bold red" },
  styleVariables: ["added_style", "deleted_style"],
  resolveStyleVariables: ({ styles }) => styles,
  options: { only_nonzero_diffs: { kind: "boolean", default: true } },
  values(context) {
    const values = workspaceModuleValues("jj_metrics", context);
    if (!values) return undefined;
    if (context.options.only_nonzero_diffs === false) return values;
    return { added: values.added === "0" ? "" : values.added, deleted: values.deleted === "0" ? "" : values.deleted };
  },
});

const statusTemplates = {
  conflicted: "!",
  description_empty: "◌",
  description_present: "",
  hidden: "",
  immutable: "◆",
  added: "+",
  copied: "=",
  deleted: "✘",
  modified: "~",
  renamed: "»",
} as const;

export const jjStatusModule = defineModule({
  name: "jj_status",
  variables: [
    "all",
    "conflicted",
    "description",
    "hidden",
    "immutable",
    "added",
    "copied",
    "deleted",
    "modified",
    "renamed",
  ],
  defaults: { format: "([\\[$all\\]]($style) )", symbol: "", style: "bold red", disabled: true },
  options: Object.fromEntries(
    Object.entries(statusTemplates).map(([key, value]) => [
      key,
      {
        kind: "string" as const,
        default: value,
        allowEmpty: true,
        templateVariables: ["added", "copied", "deleted", "modified", "renamed"].includes(key) ? ["count"] : [],
      },
    ]),
  ),
  values(context) {
    const snapshot = workspaceModuleValues("jj_status", context);
    if (!snapshot) return undefined;
    const values: Record<string, FormatValue> = {};
    const symbol = (name: keyof typeof statusTemplates, active = true, count?: string) =>
      active ? statusValue(stringOption(context, name, statusTemplates[name]), count, context) : [];
    values.conflicted = symbol("conflicted", snapshot.conflicted === "true");
    values.description = symbol(snapshot.has_description === "true" ? "description_present" : "description_empty");
    values.hidden = symbol("hidden", snapshot.hidden === "true");
    values.immutable = symbol("immutable", snapshot.immutable === "true");
    for (const name of ["added", "copied", "deleted", "modified", "renamed"] as const) {
      values[name] = symbol(name, Number(snapshot[name]) > 0, snapshot[name]);
    }
    values.all = Object.values(values).flatMap((value) => (Array.isArray(value) ? value : []));
    return values;
  },
});

export const jujutsuModules = [jjBookmarkModule, jjChangeModule, jjMetricsModule, jjStatusModule] as const;

function parseBookmark(raw: unknown): { name: string; remote?: string; diverged: boolean } | undefined {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("name" in raw) ||
    !("remote" in raw) ||
    !("diverged" in raw) ||
    typeof raw.name !== "string" ||
    typeof raw.remote !== "string" ||
    typeof raw.diverged !== "boolean"
  )
    return undefined;
  // Transport raw fields, not JJ revset display labels: @, quotes and trailing *
  // can be literal name characters. Sanitize before filtering and truncation.
  const remote = sanitizeTerminalText(raw.remote);
  return { name: sanitizeTerminalText(raw.name), remote: remote || undefined, diverged: raw.diverged };
}

function idParts(id: string, prefixLength: number, hashLength: number) {
  const text = sanitizeTerminalText(id);
  const start = Math.min(text.length, Number.isFinite(prefixLength) ? Math.max(0, prefixLength) : 0);
  return { prefix: text.slice(0, start), suffix: text.slice(start, Math.max(start, hashLength)) };
}

function stringOption(context: ModuleValueContext, key: string, fallback: string): string {
  const value = context.options[key];
  return typeof value === "string" ? sanitizeTerminalText(value) : fallback;
}

function integerOption(context: ModuleValueContext, key: string, fallback: number): number {
  const value = context.options[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function stringList(context: ModuleValueContext, key: string): readonly string[] {
  const value = context.options[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(sanitizeTerminalText)
    : [];
}

function statusValue(template: string, count: string | undefined, context: ModuleValueContext): readonly LayoutChunk[] {
  return renderStatusTemplate(template, count === undefined ? {} : { count }, context.palette);
}
