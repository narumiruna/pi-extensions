import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

registerRuntimeBuilderContract({
  packageId: "pi-context-management",
  forbiddenEagerInputs: ["src/settings-menu.ts"],
  forbiddenEagerExternal: "@narumitw/pi-tui-kit",
});
