import { isKeyRelease, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { DocumentCopyAction } from "../types.js";
import type { MenuKeybindings, RenderHost } from "./contracts.js";
import { componentKeyAvailable } from "./host-input.js";
import { canonicalKeyId, keysOverlap, usesDisambiguatedKeyProtocol } from "./key-matching.js";
import { safeMenuText } from "./rendering.js";

interface CopyDocument {
  owner: object;
  action: DocumentCopyAction;
  content: string;
  itemId?: string;
}

interface CopySnapshot extends CopyDocument {
  label: string;
  onCopy: DocumentCopyAction["onCopy"];
}

interface DocumentCopyOptions {
  tui: RenderHost;
  keybindings: MenuKeybindings;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  document(): CopyDocument | undefined;
  includeConfirm: boolean;
  searchEnabled: boolean;
}

const STANDARD_BINDINGS = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
] as const;

/** Owns only one document action, not clipboard transport or menu transitions. */
export function createDocumentCopy(options: DocumentCopyOptions) {
  let disposed = false;
  let running = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let snapshot: CopySnapshot | undefined;
  let feedback = "";
  let pasting = false;
  const current = () => !disposed && !options.signal?.aborted && (options.isCurrent?.() ?? true);
  const sameDocument = () => {
    const document = options.document();
    return (
      snapshot !== undefined &&
      document?.owner === snapshot.owner &&
      document.action === snapshot.action &&
      document.action.label === snapshot.label &&
      document.action.onCopy === snapshot.onCopy &&
      document.content === snapshot.content &&
      document.itemId === snapshot.itemId
    );
  };
  const cancel = () => {
    controller?.abort();
    snapshot = undefined;
    feedback = "";
  };
  const sync = () => {
    if (!current() || (snapshot && !sameDocument())) cancel();
  };
  const keys = () => {
    const claimed = [
      "ctrl+c",
      "home",
      "end",
      ...(options.searchEnabled ? ["space"] : []),
      ...[...STANDARD_BINDINGS, ...(options.includeConfirm ? (["tui.select.confirm"] as const) : [])].flatMap(
        (binding) => options.keybindings.getKeys(binding).flatMap((key) => canonicalKeyId(key) ?? []),
      ),
    ];
    const enhanced = usesDisambiguatedKeyProtocol(options.tui);
    return options.keybindings.getKeys("app.message.copy").flatMap((key) => {
      const canonical = canonicalKeyId(key);
      return canonical &&
        componentKeyAvailable(options.tui, key) &&
        !claimed.some((other) => keysOverlap(canonical, other, enhanced))
        ? [canonical]
        : [];
    });
  };
  const abort = () => cancel();
  options.signal?.addEventListener("abort", abort, { once: true });

  return {
    hint(searchActive: boolean) {
      sync();
      const document = current() ? options.document() : undefined;
      if (!document) return "";
      const label = safeMenuText(document.action.label);
      const available = searchActive ? [] : keys();
      const actionHint = label && available.length > 0 ? `${available.join("/")} ${label}` : "";
      return [feedback, actionHint].filter(Boolean).join(" · ");
    },
    handleInput(data: string) {
      sync();
      // Pi's terminal delivers complete, rewrapped bracketed pastes. Retain a
      // simple gate for hosts that split at the full markers, without buffering
      // source text or interpreting pasted keys as actions.
      const wasPasting = pasting;
      if (data.includes("\u001b[200~")) pasting = true;
      const paste = wasPasting || pasting;
      if (data.includes("\u001b[201~")) pasting = false;
      if (paste || isKeyRelease(data) || !current()) return;
      const document = options.document();
      if (!document || !safeMenuText(document.action.label)) return;
      if (!keys().some((key) => matchesKey(data, key as KeyId)) || running) return;
      // Snapshot raw strings and identity before the first await. Rendering and
      // search sanitize display data only; they never change this payload.
      snapshot = { ...document, label: document.action.label, onCopy: document.action.onCopy };
      const accepted = snapshot;
      controller = new AbortController();
      const signal = controller.signal;
      running = true;
      feedback = "Copying…";
      options.tui.requestRender();
      pending = (async () => {
        let failed = false;
        try {
          await accepted.onCopy.call(accepted.action, {
            content: accepted.content,
            ...(accepted.itemId === undefined ? {} : { itemId: accepted.itemId }),
            signal,
          });
        } catch {
          // Callback errors can contain the complete source. Never expose them
          // through notifications, result unions, or an owner error reporter.
          failed = true;
        }
        sync();
        running = false;
        if (signal.aborted || !current() || !sameDocument()) return;
        feedback = failed ? "Copy failed; try again" : "Copied";
        options.tui.requestRender();
      })();
    },
    cancel,
    async waitForPending() {
      await pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      options.signal?.removeEventListener("abort", abort);
    },
  };
}
