import type { ClientFacts } from "./protocol.js";

export function sameDiffReviewBinding(left: ClientFacts, right: ClientFacts): boolean {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.generation === right.generation &&
    left.mode === right.mode &&
    left.hasUI === right.hasUI &&
    left.cwd === right.cwd &&
    left.sessionId === right.sessionId &&
    left.sessionDir === right.sessionDir &&
    left.sessionFile === right.sessionFile
  );
}
