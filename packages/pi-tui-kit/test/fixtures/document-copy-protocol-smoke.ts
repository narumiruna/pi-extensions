import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROUTES = ["review", "standalone", "browse"] as const;

/** Fake transport only: this fixture must never touch a native clipboard. */
export default function documentCopyProtocolSmoke(pi: ExtensionAPI): void {
  let owner = new AbortController();
  pi.on("session_start", () => {
    owner.abort();
    owner = new AbortController();
  });
  pi.on("session_shutdown", () => owner.abort());
  pi.registerCommand("kit-copy-protocol-smoke", {
    description: "Verify document copy mode isolation with a fake transport",
    getArgumentCompletions: (prefix) =>
      ROUTES.filter((route) => route.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const route = ROUTES.find((value) => value === args.trim());
      if (!route || (ctx.mode !== "rpc" && ctx.mode !== "tui"))
        throw new Error("Usage: /kit-copy-protocol-smoke review|standalone|browse (TUI or RPC)");
      const signal = owner.signal;
      const { defineMenu, PI_EXTENSION_MENU_API_VERSION, runMenu } = await import("@narumitw/pi-tui-kit");
      if (signal.aborted || signal !== owner.signal) return;
      let copies = 0;
      let confirmed = 0;
      const content = Array.from({ length: 32 }, (_, index) => `  source ${index}\tvalue  `).join("\r\n");
      const copy = {
        label: "Fake copy — NO OS clipboard",
        onCopy: () => {
          copies++;
          throw new Error("Fake transport invoked");
        },
      };
      let result: unknown;
      if (route === "standalone") {
        const { runDocumentReview } = await import("@narumitw/pi-tui-kit/document-review");
        if (signal.aborted || signal !== owner.signal) return;
        result = await runDocumentReview(ctx, {
          title: "Protocol review",
          content,
          copy,
          enableSearch: true,
          confirmation: { label: "Apply" },
          signal,
        });
      } else {
        result = await runMenu(
          ctx,
          defineMenu<undefined, "document", "apply">({
            start: "document",
            screens: {
              document: () =>
                route === "review"
                  ? {
                      kind: "review",
                      title: "Protocol review",
                      content,
                      copy,
                      enableSearch: true,
                      confirm: { id: "apply", label: "Apply", action: "apply" },
                    }
                  : {
                      kind: "browse",
                      title: "Protocol schemas",
                      hint: "close",
                      enableDetailSearch: true,
                      items: [{ id: "raw-schema", label: "Schema", detailDocument: { content, copy } }],
                    },
            },
            actions: {
              apply: () => {
                confirmed++;
                return { kind: "close" };
              },
            },
          }),
          { getState: () => undefined, signal },
        );
      }
      if (signal.aborted || signal !== owner.signal) return;
      ctx.ui.notify(
        JSON.stringify({
          smoke: "copy-protocol",
          route,
          copies,
          confirmed,
          result,
          api: PI_EXTENSION_MENU_API_VERSION,
        }),
        "info",
      );
    },
  });
}
