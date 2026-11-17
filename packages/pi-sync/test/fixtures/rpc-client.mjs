import "./local-network.mjs";

const { main } = await import("@earendil-works/pi-coding-agent");
try {
  await main(process.argv.slice(2), {
    extensionFactories: [
      (pi) => {
        pi.on("session_start", () => {
          process.send?.({ type: "ready" });
        });
        pi.registerCommand("test-sync-pending", {
          description: "Owned pending-command cancellation fixture",
          handler: async () => {
            process.send?.({ type: "pending" });
            await new Promise(() => {});
          },
        });
        pi.registerCommand("test-sync-reload", {
          description: "Owned lifecycle smoke",
          handler: async (_args, ctx) => {
            await ctx.reload();
          },
        });
      },
    ],
  });
} finally {
  if (process.connected) process.disconnect();
}
