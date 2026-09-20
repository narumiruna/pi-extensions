import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

registerRuntimeBuilderContract({
  packageId: "pi-herdr",
  forbiddenEagerInputs: ["src/herdr-menu.ts"],
  forbiddenEagerExternal: "@narumitw/pi-tui-kit",
});
