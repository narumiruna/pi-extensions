import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { test } from "vitest";

const helpers = [
  ["editor-status-publisher", "createEditorStatusPublisher"],
  ["editor-status-view", "createEditorStatusView"],
  ["editor-status-collection", "createEditorStatusCollection"],
] as const;

for (const [entry, name] of helpers) {
  test(`${entry} has a dependency-free focused runtime and the same root export`, async () => {
    const result = await build({
      entryPoints: [path.resolve(`packages/pi-tui-kit/dist/${entry}.js`)],
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      write: false,
      metafile: true,
    });
    assert.deepEqual(
      Object.keys(result.metafile.inputs).map((input) => path.basename(input)),
      [`${entry}.js`],
    );
    assert.deepEqual(
      Object.values(result.metafile.outputs).flatMap((output) => output.imports),
      [],
    );
    const rootSpecifier = "@narumitw/pi-tui-kit";
    const focusedSpecifier = `@narumitw/pi-tui-kit/${entry}`;
    const [root, focused] = await Promise.all([import(rootSpecifier), import(focusedSpecifier)]);
    assert.deepEqual(Object.keys(focused), [name]);
    assert.equal(root[name], focused[name]);
  });
}

test("strict external consumers can use all editor status helpers without a partial-update API", (t) => {
  const cache = path.resolve("node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, "pi-editor-status-exports-"));
  t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    path.join(fixture, "usage.ts"),
    `
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createEditorStatusPublisher, type EditorStatusPublisher, type EditorStatusPublisherOptions } from "@narumitw/pi-tui-kit/editor-status-publisher";
import { createEditorStatusView, type EditorStatusView, type EditorStatusMode, type EditorStatusTrigger } from "@narumitw/pi-tui-kit/editor-status-view";
import { createEditorStatusCollection, type EditorStatusCollection, type EditorStatusCollectionInput, type EditorStatusCollectionItem, type EditorStatusItemHandle } from "@narumitw/pi-tui-kit/editor-status-collection";
import { createEditorStatusPublisher as rootPublisher, createEditorStatusView as rootView, createEditorStatusCollection as rootCollection } from "@narumitw/pi-tui-kit";
declare const context: ExtensionContext;
const options: EditorStatusPublisherOptions<string> = { key: "fixture:status", context, isCurrent: () => true, render: (snapshot: string, theme: Theme, width: number, rows: number) => [theme.fg("muted", snapshot.slice(0, width))] };
const publisher: EditorStatusPublisher<string> = createEditorStatusPublisher(options);
publisher.publish("one"); publisher.publish(undefined); publisher.dispose();
const view: EditorStatusView = createEditorStatusView({ onChange() {}, canCompact: () => true });
const mode: EditorStatusMode = "compact"; const trigger: EditorStatusTrigger = "settled-cycle";
view.setMode(mode); view.setTrigger(trigger); view.agentStarted(); view.userMessage(); view.settled(true); view.dispose();
const collection: EditorStatusCollection<string> = createEditorStatusCollection({ maxItems: 4, maxContentSize: 20, measure: value => value.length });
const items: EditorStatusCollectionInput<string>[] = [{ id: "raw", value: "value", revision: "1" }];
collection.replace(items);
const item: EditorStatusCollectionItem<string> | undefined = collection.snapshot()[0];
const handle: EditorStatusItemHandle | undefined = collection.item("raw");
handle?.compact(); handle?.expand(); handle?.remove();
// @ts-expect-error Partial data updates are deliberately not public.
collection.upsert("raw", "value");
void item; void rootPublisher; void rootView; void rootCollection;
collection.dispose();
`,
  );
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ["usage.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [path.resolve("node_modules/typescript/bin/tsc"), "-p", path.join(fixture, "tsconfig.json")],
    { stdio: "pipe" },
  );
});
