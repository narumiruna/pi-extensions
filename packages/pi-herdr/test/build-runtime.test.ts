import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

registerRuntimeBuilderContract({
  packageId: "pi-herdr",
  forbiddenEagerInputs: ["src/herdr-menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: ["@narumitw/pi-tui-kit/editor-status-widget", "@narumitw/pi-tui-kit/terminal-text"],
});
