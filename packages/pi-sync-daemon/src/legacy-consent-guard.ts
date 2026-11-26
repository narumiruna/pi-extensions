import { ConsentPublicationError, readConsent, revokeChangedBindings } from "./consent.js";
import { loadConfigForCheck } from "./engine/settings/config.js";
import type { IdleExitPolicy } from "./idle-exit.js";
import type { ClientFacts } from "./protocol.js";

export function createLegacyConsentGuard(root: string) {
  let blocked = false;
  return {
    block() {
      blocked = true;
    },
    allowsRecovery: () => !blocked,
    async lifetime(): Promise<IdleExitPolicy> {
      if (blocked) return "pause";
      try {
        const consent = readConsent(root);
        if (consent && Object.values(consent.setups).some((saved) => saved.afterExit)) await loadConfigForCheck();
        return blocked ? "pause" : "exit";
      } catch {
        return "pause";
      }
    },
    factsChanged(peers: ClientFacts[]) {
      try {
        revokeChangedBindings(root, peers);
      } catch (error) {
        blocked = true;
        if (error instanceof ConsentPublicationError)
          throw new Error(
            "Daemon authorization could not be saved. Repair and revoke retained permission before an explicit restart.",
            { cause: error },
          );
      }
    },
  };
}
