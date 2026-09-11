import path from "node:path";

function expandHome(value: string) {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "~", value.slice(2));
  return value;
}

export function sessionStorageRoot(root: string, configuredSessionDir?: string) {
  return configuredSessionDir ? path.resolve(expandHome(configuredSessionDir)) : path.resolve(root, "sessions");
}
