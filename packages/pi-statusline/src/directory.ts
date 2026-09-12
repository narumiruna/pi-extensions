import { basename, isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

const DEFAULT_TRUNCATION_LENGTH = 3;
const DEFAULT_HOME_SYMBOL = "~";

/** Apply Starship's default directory presentation without exposing a format language. */
export function formatDirectoryPath(cwd: string, homeDir: string | undefined, gitRoot: string | undefined): string {
  const contracted =
    gitRoot && (!homeDir || !samePath(gitRoot, homeDir))
      ? (contractRepositoryPath(cwd, gitRoot) ?? contractPath(cwd, homeDir, DEFAULT_HOME_SYMBOL))
      : contractPath(cwd, homeDir, DEFAULT_HOME_SYMBOL);
  const safeContracted = sanitizeTerminalText(contracted);
  const components = safeContracted.split("/").filter((component) => component.length > 0);
  const displayed =
    components.length > DEFAULT_TRUNCATION_LENGTH
      ? components.slice(-DEFAULT_TRUNCATION_LENGTH).join("/")
      : safeContracted;
  const native = sep === "/" ? displayed : displayed.replaceAll("/", sep);
  return sanitizeTerminalText(native || basename(cwd) || cwd);
}

function toSlashPath(value: string): string {
  return sep === "\\" ? value.replaceAll("\\", "/") : value;
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
