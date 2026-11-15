import { fileURLToPath } from "node:url";
import { prepareWorkspaceRuntime } from "./prepare-workspace-runtime.mjs";

export function prepareKitRuntime(
  packageRoot = fileURLToPath(new URL("../packages/pi-tui-kit", import.meta.url)),
  options = {},
) {
  return prepareWorkspaceRuntime(packageRoot, options);
}
