// Pi Git installs omit devDependencies and load source entrypoints without packing.
// Prepare workspace runtime dependencies and Inspector assets without development tools.
const { prepareKitRuntime } = await import("./prepare-kit-runtime.mjs");
await prepareKitRuntime();
const { prepareDaemonRuntime } = await import("./prepare-daemon-runtime.mjs");
await prepareDaemonRuntime();
await import("../packages/pi-inspect/scripts/build.mjs");
