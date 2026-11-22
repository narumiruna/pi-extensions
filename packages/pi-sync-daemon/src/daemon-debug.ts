import { appendDebugEvent, type DebugEvent } from "./engine/debug-log.js";
import { readLocalConfigForDiagnostics } from "./engine/settings/config-file.js";
import { validateSettingsDocument } from "./engine/settings/settings-validation.js";

export type DaemonDiagnosticSink = (event: DebugEvent, current?: () => boolean) => void;

export function createDaemonDebug(root: string): DaemonDiagnosticSink {
  type Record = { event: DebugEvent; current?: () => boolean };
  let waiting: Record[] = [];
  let flushing = false;

  async function flush() {
    while (waiting.length) {
      const batch = waiting;
      waiting = [];
      try {
        const snapshot = await readLocalConfigForDiagnostics(root);
        if (!snapshot || validateSettingsDocument(snapshot.document.parsed).debug !== true) continue;
        for (const { event, current } of batch) {
          if ((current?.() ?? true) && snapshot.stillCurrent()) appendDebugEvent(root, "pi-sync-daemon", event);
        }
      } catch {}
    }
    flushing = false;
  }

  return (event, current) => {
    if (waiting.length >= 32) return;
    waiting.push({ event, current });
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => void flush());
  };
}
