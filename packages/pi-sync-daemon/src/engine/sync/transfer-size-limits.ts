import { parentPaths } from "../paths.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { filterSnapshotForConfigPolicy } from "../snapshot/snapshot.js";
import { snapshotBase64Size } from "../snapshot/snapshot-payload.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { snapshotPathLabel } from "../ui/terminal-text.js";
import { TransferSizeError } from "./continuous-errors.js";

const MIB = 1024 ** 2;
const MAX_FINDINGS = 8;

type SizeLimits = Pick<AnySyncConfig, "maxFileSizeMiB" | "maxDirectorySizeMiB">;
type SizePolicy = SizeLimits;

type SizeImage = Pick<Snapshot, "files"> & {
  side: "Local" | "Remote" | "Local input" | "Remote input";
};

export function transferSizeLimitsEnabled(config: SizeLimits) {
  return config.maxFileSizeMiB !== undefined || config.maxDirectorySizeMiB !== undefined;
}

export function selectedPublicationImage(snapshot: Snapshot, config: AnySyncConfig, sessionDir?: string): SizeImage {
  return {
    side: "Remote",
    files: filterSnapshotForConfigPolicy(snapshot, config, { sessionDir }).files,
  };
}

export function selectedPullImage(incoming: Snapshot, local: Snapshot, protectedPaths: ReadonlySet<string>): SizeImage {
  return {
    side: "Local",
    files: protectedPaths.size
      ? [
          ...incoming.files.filter((file) => !protectedPaths.has(file.path)),
          ...local.files.filter((file) => protectedPaths.has(file.path)),
        ]
      : incoming.files,
  };
}

interface Finding {
  path: string;
  kind: "file" | "directory";
  side: SizeImage["side"];
  size: number;
  limit: number;
}

function compareFindings(a: Finding, b: Finding) {
  if (a.side !== b.side) return a.side < b.side ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1;
}

export function transferSizeDetails(config: SizePolicy, images: readonly SizeImage[]) {
  if (!transferSizeLimitsEnabled(config)) return;
  const fileLimit = (config.maxFileSizeMiB ?? Infinity) * MIB;
  const directoryLimit = (config.maxDirectorySizeMiB ?? Infinity) * MIB;
  const findings: Finding[] = [];
  let count = 0;
  for (const { side, files } of images) {
    const directories = new Map<string, number>();
    const seen = new Set<string>();
    const measure = (path: string, size: number, kind: Finding["kind"], limit: number) => {
      if (size <= limit) return;
      count++;
      const finding = { side, path, size, kind, limit };
      if (findings.length === MAX_FINDINGS && compareFindings(finding, findings[MAX_FINDINGS - 1]) >= 0) return;
      findings.push(finding);
      findings.sort(compareFindings);
      if (findings.length > MAX_FINDINGS) findings.pop();
    };
    const measureFile = (path: string, size: number) => {
      if (seen.has(path)) return;
      seen.add(path);
      measure(path, size, "file", fileLimit);
      if (directoryLimit !== Infinity)
        for (const parent of parentPaths(path)) directories.set(parent, (directories.get(parent) ?? 0) + size);
    };
    for (const file of files) measureFile(file.path, snapshotBase64Size(file.contentBase64, file.path));
    for (const [path, size] of directories) measure(path, size, "directory", directoryLimit);
  }
  if (!count) return;
  const omitted = count - findings.length;
  return [
    ...findings.map(({ path, side, size, kind, limit }) => {
      const label = JSON.stringify(snapshotPathLabel(path.slice(0, 160))).slice(1, -1);
      const shortened = path.length > 160 || label.length > 240;
      return `${side} ${kind} "${label.slice(0, 240)}${shortened ? "…" : ""}": ${size} bytes (limit ${limit} bytes).`;
    }),
    ...(omitted ? [`${omitted} additional ${omitted === 1 ? "finding" : "findings"} omitted.`] : []),
    `Use /sync diff, adjust exclusions in /sync → Settings, then review a Push or Pull.`,
  ].join(" ");
}

export function requireTransferSize(config: SizePolicy, ...images: SizeImage[]) {
  const details = transferSizeDetails(config, images);
  if (details) throw new TransferSizeError(`Transfer blocked by size limits. ${details}`);
}
