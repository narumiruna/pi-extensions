import { basename, isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { replacePattern } from "../format/bounded-regex.js";
import { graphemes, toSlashPath, truncatePathComponents, useNativePathSeparator } from "./truncation.js";
import { defineModule, type ModuleValueContext } from "./types.js";

export const DIRECTORY_REPO_ROOT_FORMAT =
  "[ $symbol ]($style)[$before_root_path]($before_repo_root_style)[$repo_root]($repo_root_style)[$path ]($style)[$read_only]($read_only_style)";
const MAX_SUBSTITUTED_PATH_LENGTH = 16_384;
const MAX_SUBSTITUTIONS = 64;

export const directoryModule = defineModule({
  name: "directory",
  variables: ["symbol", "path", "full_path", "before_root_path", "repo_root", "read_only"],
  defaults: {
    format: "[ $symbol $path ]($style)",
    symbol: "📁",
    style: "cyan bold",
    disabled: false,
  },
  fallbackStyle: true,
  styleDefaults: { repo_root_style: "", before_repo_root_style: "", read_only_style: "red" },
  styleVariables: ["style", "repo_root_style", "before_repo_root_style", "read_only_style"],
  resolveStyleVariables: ({ style, styles }) => ({
    style,
    repo_root_style: styles.repo_root_style || style,
    before_repo_root_style: styles.before_repo_root_style || style,
    read_only_style: styles.read_only_style ?? "red",
  }),
  options: {
    truncation_length: { kind: "integer", default: 3, minimum: 0, maximum: 1_000_000 },
    truncate_to_repo: { kind: "boolean", default: true },
    fish_style_pwd_dir_length: { kind: "integer", default: 0, minimum: 0, maximum: 1_000 },
    truncation_symbol: { kind: "string", default: "" },
    home_symbol: { kind: "string", default: "~" },
    use_os_path_sep: { kind: "boolean", default: true },
    use_logical_path: { kind: "boolean", default: true },
    // Empty is an inheritance sentinel, not an implicit second active format.
    repo_root_format: { kind: "string", default: "", allowEmpty: true },
    read_only: { kind: "string", default: "🔒", allowEmpty: true },
    substitutions: { kind: "substitutions", default: {} },
  },
  resolveFormat: (context, values) =>
    values.repo_root ? directoryAlternateFormat(context.options, context.styles) : undefined,
  values: directoryValues,
});

/** A second format is reachable only after an explicit format or root style. */
export function directoryAlternateFormat(
  options: Readonly<Record<string, unknown>>,
  styles: Readonly<Record<string, string>> = {},
): string | undefined {
  return (
    stringOption(options, "repo_root_format", "") || (styles.repo_root_style ? DIRECTORY_REPO_ROOT_FORMAT : undefined)
  );
}

function directoryValues({ runtime, options, styles }: ModuleValueContext): Record<string, string> {
  const metadata = runtime.workspace?.modules.directory;
  // Pi exposes one cwd. Logical mode preserves it; physical mode consumes only
  // cached runtime metadata, with the original cwd as the failure fallback.
  const fullPath = sanitizeTerminalText(
    booleanOption(options, "use_logical_path", true) ? runtime.cwd : metadata?.physical_path || runtime.cwd,
  );
  const home = runtime.homeDir === undefined ? undefined : sanitizeTerminalText(runtime.homeDir);
  const repoRoot = runtime.gitRoot === undefined ? undefined : sanitizeTerminalText(runtime.gitRoot);
  const homeSymbol = sanitizeTerminalText(stringOption(options, "home_symbol", "~"));
  const truncateToRepo = booleanOption(options, "truncate_to_repo", true);
  const substitutions = substitutionsOption(options);
  const homeContracted = contractPath(fullPath, home, homeSymbol);
  const repoPath = repoRoot ? contractRepositoryPath(fullPath, repoRoot) : undefined;
  const repoContracted = truncateToRepo && repoRoot && (!home || !samePath(repoRoot, home)) ? repoPath : undefined;
  const contracted = repoContracted ?? homeContracted;
  const substituted = substitutePath(contracted, substitutions);
  const componentResult = truncatePathComponents(substituted, numberOption(options, "truncation_length", 3));
  let path = componentResult.value;
  let prefix = "";
  if (repoContracted !== undefined || componentResult.truncated) {
    const fishLength = numberOption(options, "fish_style_pwd_dir_length", 0);
    prefix =
      fishLength > 0 && substitutions.length === 0
        ? fishPrefix(homeContracted, path, fishLength)
        : sanitizeTerminalText(stringOption(options, "truncation_symbol", ""));
  }

  let beforeRoot = "";
  let root = "";
  if (directoryAlternateFormat(options, styles) && repoPath !== undefined && repoRoot) {
    const split = splitRepositoryPath(contracted, substituted, path, repoPath, repoRoot, substitutions);
    if (split) {
      beforeRoot = prefix + split.before;
      root = split.root;
      path = split.after;
      prefix = "";
    }
  }
  if (!root) path = prefix + path;
  const fallback = basename(fullPath) || fullPath;
  const native = booleanOption(options, "use_os_path_sep", true);
  return {
    path: sanitizeTerminalText(
      native ? useNativePathSeparator(path || (root ? "" : fallback)) : path || (root ? "" : fallback),
    ),
    before_root_path: sanitizeTerminalText(native ? useNativePathSeparator(beforeRoot) : beforeRoot),
    repo_root: sanitizeTerminalText(native ? useNativePathSeparator(root) : root),
    full_path: fullPath,
    read_only: metadata?.read_only === "true" ? sanitizeTerminalText(stringOption(options, "read_only", "🔒")) : "",
  };
}

interface Substitution {
  readonly from: string;
  readonly to: string;
  readonly regex?: boolean;
}

function substitutionsOption(options: Readonly<Record<string, unknown>>): readonly Substitution[] {
  const value = options.substitutions;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("from" in item) || !("to" in item)) return [];
      if (typeof item.from !== "string" || typeof item.to !== "string") return [];
      return [
        {
          from: sanitizeTerminalText(item.from),
          to: sanitizeTerminalText(item.to),
          regex: "regex" in item && item.regex === true,
        },
      ];
    });
  }
  return Object.entries(value).flatMap(([from, to]) =>
    typeof to === "string" ? [{ from: sanitizeTerminalText(from), to: sanitizeTerminalText(to) }] : [],
  );
}

function substitutePath(path: string, substitutions: readonly Substitution[]): string {
  if (path.length > MAX_SUBSTITUTED_PATH_LENGTH || substitutions.length > MAX_SUBSTITUTIONS) return path;
  let result = path;
  for (const { from, to, regex } of substitutions) {
    // Preserve the existing Pi behavior for empty literal keys. Regex empty
    // matches are handled by the bounded matcher instead.
    if (!from && !regex) continue;
    const next = regex ? replacePattern(from, result, to) : replaceLiteral(from, result, to);
    // Like upstream's invalid-regex branch, a failed substitution discards the
    // complete substitution sequence, not just its failing row.
    if (next === undefined || next.length > MAX_SUBSTITUTED_PATH_LENGTH) return path;
    result = next;
  }
  return result;
}

function replaceLiteral(from: string, value: string, to: string): string | undefined {
  const parts: string[] = [];
  let offset = 0;
  let length = 0;
  while (true) {
    const match = value.indexOf(from, offset);
    const end = match === -1 ? value.length : match;
    const part = value.slice(offset, end);
    length += part.length + (match === -1 ? 0 : to.length);
    if (length > MAX_SUBSTITUTED_PATH_LENGTH) return undefined;
    parts.push(part);
    if (match === -1) return parts.join("");
    parts.push(to);
    offset = match + from.length;
  }
}

function splitRepositoryPath(
  contracted: string,
  substituted: string,
  displayed: string,
  repoPath: string,
  repoRoot: string,
  substitutions: readonly Substitution[],
): { before: string; root: string; after: string } | undefined {
  if (!contracted.endsWith(repoPath) || !substituted.endsWith(displayed)) return undefined;
  const rootName = basename(repoRoot) || toSlashPath(repoRoot);
  const start = contracted.length - repoPath.length;
  const before = substitutePath(contracted.slice(0, start), substitutions);
  const root = substitutePath(rootName, substitutions);
  const after = substitutePath(repoPath.slice(rootName.length), substitutions);
  // A replacement spanning a style boundary has no unambiguous split. Preserve
  // its exact path output through the normal format instead of dropping text.
  if (!root || before + root + after !== substituted) return undefined;
  const omitted = substituted.length - displayed.length;
  if (before.length < omitted) return undefined;
  return { before: before.slice(omitted), root, after };
}

function contractPath(path: string, root: string | undefined, replacement: string): string {
  if (!root) return toSlashPath(path);
  const child = relativeWithin(path, root);
  if (child === undefined) return toSlashPath(path);
  return child ? `${replacement}/${child}` : replacement;
}

function contractRepositoryPath(path: string, root: string): string | undefined {
  const child = relativeWithin(path, root);
  if (child === undefined) return undefined;
  const name = basename(root) || toSlashPath(root);
  return child ? `${name}/${child}` : name;
}

function relativeWithin(path: string, root: string): string | undefined {
  const child = relative(root, path);
  if (child === "") return "";
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
  return toSlashPath(child);
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function fishPrefix(source: string, displayed: string, length: number): string {
  const prefix = source.endsWith(displayed) ? source.slice(0, -displayed.length) : "";
  if (!prefix) return "";
  return prefix
    .split("/")
    .map((component) => abbreviateComponent(component, length))
    .join("/");
}

function abbreviateComponent(component: string, length: number): string {
  if (!component) return "";
  const parts = graphemes(component);
  if (parts.length <= length) return component;
  return component.startsWith(".") ? parts.slice(0, length + 1).join("") : parts.slice(0, length).join("");
}

function numberOption(options: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === "number" ? value : fallback;
}

function stringOption(options: Readonly<Record<string, unknown>>, name: string, fallback: string): string {
  const value = options[name];
  return typeof value === "string" ? value : fallback;
}

function booleanOption(options: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
  const value = options[name];
  return typeof value === "boolean" ? value : fallback;
}
