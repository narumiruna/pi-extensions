import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { configureEngineHost } from "@narumitw/pi-sync-daemon/engine/host";

// These disposable child fixtures deliberately host the extracted engine themselves.
configureEngineHost({ root: getAgentDir, mutate: withFileMutationQueue, review: async () => false });
