// Pi Git installs omit devDependencies and load source entrypoints without packing.
// Prepare workspace runtime dependencies and Inspector assets before optional development hooks.
const { prepareKitRuntime } = await import("./prepare-kit-runtime.mjs");
await prepareKitRuntime();
await import("../packages/pi-inspect/scripts/build.mjs");
await import("../.husky/install.mjs");
