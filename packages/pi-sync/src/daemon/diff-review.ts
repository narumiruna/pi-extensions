import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DaemonError,
  type DiffReviewInventory,
  type DiffReviewPreview,
  parseDiffReviewInventory,
} from "@narumitw/pi-sync-daemon";
import { piDaemonClient } from "./pi-client.js";

export type ActiveDiffReview = Extract<DiffReviewInventory, { kind: "review" }> & {
  read(fileId: string, signal?: AbortSignal): Promise<DiffReviewPreview>;
  close(): Promise<void>;
};
export type OpenDiffReviewResult = ActiveDiffReview | Extract<DiffReviewInventory, { kind: "unavailable" }>;

export async function openDiffReview(
  ctx: ExtensionContext,
  setup: string | undefined,
  fingerprint: string | undefined,
  signal?: AbortSignal,
): Promise<OpenDiffReviewResult> {
  const client = piDaemonClient(ctx);
  const connection = await client.connect(undefined, signal);
  const generation = client.generation;
  const validate = () => {
    client.validate();
    if (client.generation !== generation) throw new Error("The Sync review owner changed.");
  };
  validate();
  signal?.throwIfAborted();
  let inventory: DiffReviewInventory;
  try {
    inventory = parseDiffReviewInventory(
      await client.run(
        "diff.review",
        { ...(setup === undefined ? {} : { setup }), ...(fingerprint === undefined ? {} : { fingerprint }) },
        signal,
        ctx,
      ),
    );
  } catch (error) {
    if (error instanceof DaemonError && error.message === "Unsupported engine operation.") {
      return {
        kind: "unavailable",
        message: "File previews need a compatible Pi Sync daemon. Reload Pi to update it.",
      };
    }
    throw error;
  }
  if (inventory.kind !== "review") return inventory;
  const reviewId = inventory.id;
  return {
    ...inventory,
    async read(fileId, signal) {
      validate();
      if ((await client.verifyConnection(signal)) !== connection) return { kind: "stale" };
      validate();
      signal?.throwIfAborted();
      const preview = await connection.readDiffReview(reviewId, fileId, signal);
      validate();
      signal?.throwIfAborted();
      return preview;
    },
    async close() {
      await connection.closeDiffReview(reviewId, AbortSignal.timeout(2_000)).catch(() => {});
    },
  };
}
