import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

registerRuntimeBuilderContract({
  packageId: "pi-context-management",
  forbiddenEagerInputs: ["src/settings-menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});
