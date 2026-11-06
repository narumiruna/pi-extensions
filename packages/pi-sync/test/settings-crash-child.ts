import { loadConfigForCheck } from "../src/settings/config.js";
import {
  withConfigPublicationReadyHookForTest,
  withConfigReplacementInstalledHookForTest,
} from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";

const action = process.argv[2];
if (action === "read") {
  try {
    const settings = await readLocalConfigObject();
    const config = await loadConfigForCheck();
    process.send?.({
      event: "read",
      automatic: settings?.syncSetups.home?.sync.automatic,
      showStatus: settings?.showStatus,
      future: settings?.future,
      checkedAutomatic: config.automatic,
      checkedShowStatus: config.showStatus,
    });
  } catch (error) {
    process.send?.({ event: "error", error: String(error) });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else if (action === "before" || action === "after") {
  const hook = action === "before" ? withConfigPublicationReadyHookForTest : withConfigReplacementInstalledHookForTest;
  await hook(
    async () => {
      setInterval(() => undefined, 1000);
      process.send?.({ event: "ready" });
      await new Promise<never>(() => undefined);
    },
    () => updateLocalConfig((settings) => ({ ...settings, showStatus: false })),
  );
} else {
  throw new Error(`Unknown settings crash action: ${action}`);
}
