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
