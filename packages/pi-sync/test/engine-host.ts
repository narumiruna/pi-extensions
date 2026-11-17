import { type ExtensionContext, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { configureEngineHost, engineHost } from "@narumitw/pi-sync-daemon/engine/host";
import { type SyncStatusPresentation, setSyncStatus } from "../src/ui/sync-status.js";

/** Scope an explicitly injected engine-unit action; never used by the production client. */
export async function withEngineFixtureHost<T>(action: () => Promise<T>): Promise<T> {
  const previous = engineHost();
  installEngineFixtureHost();
  try {
    return await action();
  } finally {
    configureEngineHost(previous);
  }
}

/** Explicit in-process host for engine unit fixtures only. Never a production fallback. */
export function installEngineFixtureHost() {
  configureEngineHost({
    root: getAgentDir,
    mutate: (target, action) => withFileMutationQueue(target, action),
    review: async (context, request, signal, isCurrent) => {
      const { confirmMergeReview } = await import("../src/ui/merge-review.js");
      if (signal?.aborted || !isCurrent()) return false;
      return confirmMergeReview(
        context as ExtensionContext,
        request.title,
        request.content,
        signal,
        isCurrent,
        request.confirmationLabel,
        request.summaryLines,
      );
    },
    status: (context, value, presentation) =>
      setSyncStatus(context as ExtensionContext, value, presentation as SyncStatusPresentation | undefined),
  });
}
