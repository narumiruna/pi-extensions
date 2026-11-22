import { createHash } from "node:crypto";
import type { SnapshotFile } from "./snapshot-types.js";

const checked = new WeakMap<SnapshotFile, { contentBase64: string; sha256: string }>();

function checkPayload(file: SnapshotFile, message: string, materialize: true): Buffer;
function checkPayload(file: SnapshotFile, message: string, materialize?: false): Buffer | undefined;
function checkPayload(file: SnapshotFile, message: string, materialize = false): Buffer | undefined {
  const { contentBase64, sha256 } = file;
  if (typeof contentBase64 !== "string" || typeof sha256 !== "string") throw new Error(message);
  const cacheable =
    Object.getOwnPropertyDescriptor(file, "contentBase64")?.value === contentBase64 &&
    Object.getOwnPropertyDescriptor(file, "sha256")?.value === sha256;
  const previous = cacheable ? checked.get(file) : undefined;
  if (previous?.contentBase64 === contentBase64 && previous.sha256 === sha256)
    return materialize ? Buffer.from(contentBase64, "base64") : undefined;
  const content = Buffer.from(contentBase64, "base64");
  if (content.toString("base64") !== contentBase64 || createHash("sha256").update(content).digest("hex") !== sha256)
    throw new Error(message);
  if (cacheable) checked.set(file, { contentBase64, sha256 });
  return content;
}

export function assertSnapshotFilePayload(file: SnapshotFile, message: string) {
  checkPayload(file, message);
}

export function materializeSnapshotFilePayload(file: SnapshotFile, message: string): Buffer {
  return checkPayload(file, message, true);
}

export function snapshotFileFromBlob(path: string, content: Buffer, sha256: string, message: string): SnapshotFile {
  if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error(message);
  const contentBase64 = content.toString("base64");
  const file = { path, contentBase64, sha256 };
  checked.set(file, { contentBase64, sha256 });
  return file;
}

export function snapshotBase64Size(value: string, filePath: string) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/u.test(value))
    throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function decodeBase64Strict(value: string, filePath: string) {
  snapshotBase64Size(value, filePath);
  return Buffer.from(value, "base64");
}
