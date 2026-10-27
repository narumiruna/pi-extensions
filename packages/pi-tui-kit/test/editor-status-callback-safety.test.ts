import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createEditorStatusPublisher, type EditorStatusPublisherOptions } from "../src/editor-status-publisher.js";
import { createEditorStatusView, type EditorStatusView } from "../src/editor-status-view.js";

test("publisher keeps the key it acquired even when its caller changes the options object", () => {
  const entries = new Map<string, unknown>([["sibling", ["keep"]]]);
  const context = {
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: {},
      setWidget(key: string, content: unknown) {
        if (content === undefined) entries.delete(key);
        else entries.set(key, content);
      },
    },
  } as unknown as ExtensionContext;
  const options: EditorStatusPublisherOptions<string> = {
    key: "owned",
    context,
    isCurrent: () => true,
    render: (text) => [text],
  };
  const publisher = createEditorStatusPublisher(options);
  publisher.publish("latest");
  options.key = "sibling";
  publisher.dispose();
  assert.deepEqual([...entries], [["sibling", ["keep"]]]);
});

for (const action of ["dispose", "pin", "manual-view", "revision"] as const) {
  test(`compaction revalidates owner policy after a reentrant ${action} callback`, () => {
    let view: EditorStatusView;
    let first = true;
    let changes = 0;
    view = createEditorStatusView({
      onChange() {
        changes++;
      },
      canCompact() {
        if (first) {
          first = false;
          if (action === "dispose") view.dispose();
          else if (action === "pin") view.setPinned(true);
          else if (action === "manual-view") view.setMode("expanded");
          else view.revision("replacement");
        }
        return true;
      },
    });
    view.setTrigger("user-message");
    const before = changes;
    view.userMessage();
    assert.equal(view.mode, action === "manual-view" ? "expanded" : "default");
    assert.equal(changes - before, action === "pin" || action === "manual-view" ? 1 : 0);
    if (action === "revision") {
      view.userMessage();
      assert.equal(view.mode, "compact");
    }
  });
}
