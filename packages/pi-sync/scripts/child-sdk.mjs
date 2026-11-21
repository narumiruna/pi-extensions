import { registerHooks } from "node:module";

const scope = new URL("./", import.meta.url).href;
let sdk;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(scope)) {
      const codingAgent = specifier === "@earendil-works/pi-coding-agent";
      if (codingAgent || specifier === "@earendil-works/pi-ai" || specifier === "@earendil-works/pi-tui") {
        sdk ??= import.meta.resolve("@narumitw/sync-node-sdk");
        if (codingAgent) return nextResolve(sdk, context);
        return nextResolve(specifier, { ...context, parentURL: sdk });
      }
    }
    return nextResolve(specifier, context);
  },
});
