import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const packageRoot = path.resolve("packages/pi-tui-kit");

test("built Markdown entrypoint resolves its runtime and type exports", async (t) => {
  const markdownSpecifier = "@narumitw/pi-tui-kit/markdown";
  const markdown = await import(markdownSpecifier);
  assert.deepEqual(Object.keys(markdown).sort(), [
    "createMermaidMarkdownTransformer",
    "prepareMermaidMarkdownRenderer",
  ]);

  const cacheRoot = path.resolve("node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const fixture = mkdtempSync(path.join(cacheRoot, "pi-tui-kit-markdown-export-"));
  t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(
    path.join(fixture, "usage.ts"),
    `import type { MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";\n` +
      `import { createMermaidMarkdownTransformer, type MermaidMarkdownTheme, prepareMermaidMarkdownRenderer } from "@narumitw/pi-tui-kit/markdown";\n` +
      `const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as MermaidMarkdownTheme;\n` +
      `const compatibleTheme: Pick<Theme, "fg" | "bold"> = theme;\n` +
      `const preparation: Promise<void> | undefined = prepareMermaidMarkdownRenderer("~~~mermaid\\nflowchart LR\\n A --> B\\n~~~");\n` +
      `const transformer: MarkdownTransformer | undefined = createMermaidMarkdownTransformer(theme);\n` +
      `void compatibleTheme;\nvoid preparation;\nvoid transformer;\n`,
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
      include: ["usage.ts"],
    }),
  );
  const tsc = path.resolve("node_modules/.bin/tsc");
  execFileSync(tsc, ["-p", path.join(fixture, "tsconfig.json")], {
    cwd: packageRoot,
    stdio: "pipe",
  });
});
