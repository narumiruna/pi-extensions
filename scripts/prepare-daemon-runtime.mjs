import { fileURLToPath } from "node:url";
import { prepareWorkspaceRuntime } from "./prepare-workspace-runtime.mjs";

export function prepareDaemonRuntime(
  packageRoot = fileURLToPath(new URL("../packages/pi-sync-daemon", import.meta.url)),
) {
  return prepareWorkspaceRuntime(packageRoot, { requiredEntries: ["index.js", "cli.js"], executables: ["cli.js"] });
}
