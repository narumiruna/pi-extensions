import { encodeSnapshot } from "../snapshot/snapshot-codec.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";

export function capturePublicationImage(snapshot: Snapshot): Snapshot {
  if (!Array.isArray(snapshot.files)) throw new Error("Invalid snapshot publication files.");
  return {
    ...snapshot,
    selection: structuredClone(snapshot.selection),
    localFields: snapshot.localFields && [...snapshot.localFields],
    files: snapshot.files.map((file) => ({ ...file })),
  };
}

export async function encodeForPublication(image: Snapshot, prepareRemote: () => Promise<void>) {
  const [prepared, encoding] = await Promise.allSettled([prepareRemote(), encodeSnapshot(image)]);
  if (prepared.status === "rejected") throw prepared.reason;
  if (encoding.status === "rejected") throw encoding.reason;
  return encoding.value;
}
