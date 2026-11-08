interface IndexedProjectFile {
  path: string;
  displayPath: string;
  segments: readonly string[];
}

export type ProjectBrowserItem =
  | { kind: "directory"; path: string; label: string }
  | { kind: "file"; path: string; label: string };

export class ProjectFileBrowser {
  private readonly files: readonly IndexedProjectFile[];
  private readonly filesByPath: ReadonlyMap<string, IndexedProjectFile>;

  constructor(paths: readonly string[]) {
    this.files = paths.map((path) => {
      const displayPath = safeTerminalText(path);
      return { path, displayPath, segments: displayPath.split("/") };
    });
    this.filesByPath = new Map(this.files.map((file) => [file.path, file]));
  }

  list(directory: string): ProjectBrowserItem[] {
    const directorySegments = directory ? directory.split("/") : [];
    const directories = new Map<string, ProjectBrowserItem>();
    const files: ProjectBrowserItem[] = [];

    for (const file of this.files) {
      if (!startsWithSegments(file.segments, directorySegments)) continue;
      const childIndex = directorySegments.length;
      const label = file.segments[childIndex];
      if (!label) continue;
      if (file.segments.length > childIndex + 1) {
        const path = [...directorySegments, label].join("/");
        directories.set(path, { kind: "directory", path, label });
        continue;
      }
      files.push({ kind: "file", path: file.path, label });
    }

    return [...[...directories.values()].sort(compareBrowserItems), ...files.sort(compareBrowserItems)];
  }

  searchResults(paths: readonly string[]): ProjectBrowserItem[] {
    return paths.flatMap((path) => {
      const file = this.filesByPath.get(path);
      return file ? [{ kind: "file" as const, path: file.path, label: file.displayPath }] : [];
    });
  }
}

export function parentProjectDirectory(directory: string): string {
  const separator = directory.lastIndexOf("/");
  return separator < 0 ? "" : directory.slice(0, separator);
}

export function safeTerminalText(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
}

function startsWithSegments(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function compareBrowserItems(left: ProjectBrowserItem, right: ProjectBrowserItem): number {
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
}
