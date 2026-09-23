import * as fs from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolSourceId } from "./attachment-utils.js";
import { MAX_READINESS_FRAME_BYTES, takeCapturedReadiness } from "./broker-credentials.js";

export interface ChildReadinessState {
  fd: number;
  expectedTools: string[];
}

const captured = takeCapturedReadiness();

const childReadinessProbe: ExtensionFactory = captured ? createChildReadinessProbe(captured) : () => undefined;

export default childReadinessProbe;

export function createChildReadinessProbe(
  readiness: ChildReadinessState,
  writeFrame: (fd: number, frame: string) => void = writeReadinessFrame,
  close: (fd: number) => void = closeDescriptor,
): ExtensionFactory {
  return (pi) => {
    let settled = false;
    const publish = (value: { ok: true; sources: string[] } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      const frame = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(frame, "utf8") > MAX_READINESS_FRAME_BYTES) {
        close(readiness.fd);
        throw new Error("Pi-subagents readiness frame exceeded its size limit.");
      }
      try {
        writeFrame(readiness.fd, frame);
      } finally {
        close(readiness.fd);
      }
    };

    pi.on("resources_discover", () => {
      const active = new Set(pi.getActiveTools());
      const missing = readiness.expectedTools.filter((tool) => !active.has(tool));
      if (missing.length > 0) {
        publish({ ok: false, error: `Unavailable subagent tools: ${missing.join(", ")}.` });
        return;
      }
      const sources = new Map(pi.getAllTools().map((tool) => [tool.name, tool.sourceInfo.path]));
      publish({
        ok: true,
        sources: readiness.expectedTools.map((tool) => {
          const source = sources.get(tool);
          return source ? toolSourceId(source) : "";
        }),
      });
    });

    pi.on("session_shutdown", () => {
      publish({ ok: false, error: "Subagent child shut down before readiness completed." });
    });
  };
}

function writeReadinessFrame(fd: number, frame: string): void {
  fs.writeFileSync(fd, frame, "utf8");
}

function closeDescriptor(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor may already be closed after a failed write.
  }
}
