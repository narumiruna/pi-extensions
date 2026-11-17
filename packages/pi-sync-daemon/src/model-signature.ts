import { createHash } from "node:crypto";

/** Preserve the engine's existing JSON model identity without copying credential-bearing values. */
export function modelSignature(model: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(model) ?? "null")
    .digest("hex");
}
