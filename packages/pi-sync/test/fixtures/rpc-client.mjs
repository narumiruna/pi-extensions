import "./local-network.mjs";

process.send?.({ type: "ready" });
const { main } = await import("@earendil-works/pi-coding-agent");
try {
  await main(process.argv.slice(2), {
    extensionFactories: [
      (pi) => {
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
