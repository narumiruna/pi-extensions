import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [role, root, sdkPath] = process.argv.slice(2);
const target = path.join(root, "settings.json");
if (role === "writer") {
  const { SettingsManager } = await import(pathToFileURL(sdkPath).href);
  const manager = SettingsManager.create(root, root);
  process.on("message", async (message) => {
    if (message.action === "stop") {
      process.disconnect();
      return;
    }
    manager.setTheme(message.theme);
    await manager.flush();
    process.send({
      event: "written",
      errors: manager.drainErrors().map((entry) => entry.error.message),
      bytes: await fs.readFile(target, "utf8"),
    });
  });
  process.send({ event: "ready" });
} else {
  const { installServiceHost } = await import("../../dist/service-host.js");
  const { engineHost } = await import("../../dist/engine/host.js");
  const host = installServiceHost(root);
  const controller = new AbortController();
  const execution = {
    root,
    signal: controller.signal,
    clientId: undefined,
    facts: () => undefined,
    participants: () => [],
    liveClients: () => (role === "missing" ? [{ id: "fixture", generation: "fixture", idle: true }] : []),
    withParticipants: async (action) => action(execution.participants()),
    validate: () => controller.signal.throwIfAborted(),
    request: async (kind) => {
      if (kind.startsWith("queue-")) return true;
      throw new Error("Unexpected callback");
    },
    emit: () => {},
    committed: () => {},
  };
  try {
    await host.run(execution, () =>
      engineHost().mutate(target, async () => {
        process.send({ event: "held" });
        await new Promise((resolve) => process.once("message", resolve));
        await fs.writeFile(target, JSON.stringify({ theme: "remote", daemonOnly: "preserve" }));
      }),
    );
    process.send({ event: "released" }, () => process.disconnect());
  } catch (error) {
    process.send({ event: "refused", message: error.message }, () => process.disconnect());
  }
}
