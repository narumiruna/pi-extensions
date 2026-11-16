import type { SnapshotFile } from "../snapshot/snapshot-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import type { ConflictArtifact } from "./conflict-artifacts.js";

export const CONFLICT_DISPLAY_BYTES = 2 * 1024 * 1024;
const tooLarge = () =>
  new Error(
    "Conflict review exceeds the 2 MiB display bound; inspect private evidence and use a reviewed explicit direction.",
  );

/** Index once and refuse a version before decoding if it cannot fit the remaining display budget. */
export function conflictPreview(artifact: ConflictArtifact, paths: readonly string[], destination: string) {
  const index = (files: SnapshotFile[]) => new Map(files.map((file) => [file.path, file]));
  const ancestors = index(artifact.ancestors ?? []);
  const local = index(artifact.local.files);
  const remote = index(artifact.remote.files);
  const parts: string[] = [];
  let size = 0;
  const remaining = () => CONFLICT_DISPLAY_BYTES - size - (parts.length ? 1 : 0);
  const append = (value: string, prefix = "") => {
    if (Buffer.byteLength(value) + Buffer.byteLength(prefix) > remaining()) throw tooLarge();
    // Sanitize at the display boundary, retaining line endings and raw evidence unchanged.
    parts.push(prefix + value.split("\n").map(safeTerminalText).join("\n"));
    size += Buffer.byteLength(prefix) + Buffer.byteLength(value) + (parts.length > 1 ? 1 : 0);
  };
  const version = (files: Map<string, SnapshotFile>, filePath: string) => {
    const file = files.get(filePath);
    if (!file) return append("(absent)");
    append(file.sha256, "sha256: ");
    if (Buffer.byteLength(file.contentBase64, "base64") > remaining()) throw tooLarge();
    const bytes = Buffer.from(file.contentBase64, "base64");
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return append(file.contentBase64, "base64: ");
    }
    append(value);
  };
  append(safeTerminalText(destination), "Storage: ");
  append(
    "Private conflict versions. Historical artifact is not authority for changed bytes/head. No automatic activation.",
  );
  for (const filePath of paths) {
    append(safeTerminalText(filePath), "Path: ");
    append("Base:");
    const hash = artifact.state.lastFileHashes[filePath];
    if (hash && !ancestors.has(filePath)) append(`(verified ancestor unavailable; sha256: ${hash})`);
    else version(ancestors, filePath);
    append("Local:");
    version(local, filePath);
    append("Remote:");
    version(remote, filePath);
  }
  return parts.join("\n");
}
