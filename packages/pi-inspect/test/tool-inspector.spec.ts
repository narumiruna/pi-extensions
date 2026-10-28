import { expect, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import type { Json } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, runtimeToolDeclarations, skills, tools } from "./fixtures.js";

const declarations: Json[] = [
  {
    name: "read",
    description:
      'Read file contents.\nImages are attachments.\n\nCodemode: `tools.read(args) resolves to string | { type: "image" }`.',
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Relative or absolute path" },
        offset: { anyOf: [{ type: "number" }, { type: "null" }], description: "Starting line, 1-indexed" },
        limit: { type: "number", minimum: 1 },
      },
    },
  },
  {
    name: "bash",
    description: "Execute a bash command.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" }, timeout: { type: "number" } },
    },
  },
  {
    name: "edit",
    description: "Edit using exact replacement.",
    parameters: {
      type: "object",
      required: ["path", "edits"],
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            required: ["oldText", "newText"],
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "write",
    description: "Write content to a file.",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
  {
    name: "codemode",
    description:
      "Run JavaScript that calls other tools.\nUse raw JavaScript, not JSON.\n```js\nawait tools.read({ path: 'a.txt' });\n```",
    format: { type: "custom", syntax: "JavaScript" },
  },
  {
    name: "update_progress",
    description: "Replace session progress.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["text", "status"],
            properties: {
              text: { type: "string", minLength: 1, maxLength: 503 },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
            },
          },
        },
      },
      required: ["steps"],
    },
  },
  {},
  {
    name: `mcp__dynamic__${"long-name-".repeat(16)}`,
    description: "Dynamically discovered definition",
    parameters: { additionalProperties: { type: "string" } },
    outputSchema: { type: "string" },
    examples: [{ custom: "declared" }],
  },
];
let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let current: Json[] | undefined = declarations;
test.beforeEach(async () => {
  f = fixture();
  current = declarations;
  const collector = new Collector();
  server = await startServer({
    generation: "tool-inspector",
    signal: new AbortController().signal,
    snapshot: () => snapshot(f.manager, collector, "tool-inspector", 0, "Prompt", tools, ["read"], skills),
    branch: (leaf, offset) => {
      const historical = branch(f.manager, leaf, offset, skills);
      return current === undefined
        ? historical
        : {
            ...historical,
            declaredTools: { value: leaf === f.user ? [] : current, truncated: false },
          };
    },
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
});
test.afterEach(async () => server.close());
async function open(page: import("@playwright/test").Page, selected = f.assistant) {
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.locator(`.session-primary:not([hidden]) [data-trace-id="${selected}"]`).click();
  await page.getByRole("tab", { name: "tools", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Declared tools" })).toBeVisible();
}
test("tool navigation, nested documentation, raw declaration, copy, and keyboard actions", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  const docs = page.getByRole("region", { name: "Selected tool documentation" });
  const nav = page.getByRole("navigation", { name: "Declared tools" });
  await expect(nav.getByRole("button")).toHaveCount(8);
  await expect(docs.getByRole("heading", { name: "read", exact: true })).toBeVisible();
  await expect(docs).toContainText('string | { type: "image" }');
  await expect(docs).toContainText("Images are attachments.");
  await expect(docs.getByRole("row").filter({ hasText: "Relative or absolute path" })).toContainText("Yes");
  await expect(docs.getByRole("row").filter({ hasText: "Starting line" })).toContainText("No");
  await nav.getByRole("button", { name: /^edit / }).click();
  await docs.getByRole("button", { name: "edits", exact: true }).click();
  await docs.getByRole("button", { name: "items []", exact: true }).click();
  await expect(docs.getByRole("row", { name: "oldText string Yes", exact: true })).toContainText("Yes");
  await expect(docs).toContainText("newText");
  await docs.getByRole("button", { name: "edits", exact: true }).click();
  await expect(docs).not.toContainText("oldText");
  await docs.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await expect(docs.locator(".json-tree")).toBeVisible();
  await docs.locator(".tool-heading").getByRole("button", { name: "Copy display data" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(JSON.stringify(declarations[2], null, 2));
  await docs
    .locator(".json-tree summary")
    .filter({ hasText: /^parameters / })
    .click();
  await expect(docs.locator(".json-tree")).toContainText("properties");
  await nav.getByRole("button", { name: /^update_progress / }).focus();
  await page.keyboard.press("Enter");
  await docs.getByRole("button", { name: "steps", exact: true }).click();
  await docs.getByRole("button", { name: "items []", exact: true }).click();
  await expect(docs).toContainText('"pending","in_progress","completed","blocked"');
  await expect(docs).toContainText("503");
  await expect(docs).toContainText("maxItems: 50");
  for (const name of ["bash", "write", "codemode"]) {
    await nav.getByRole("button", { name: new RegExp(`^${name} `) }).click();
    await expect(docs.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(docs).toContainText("Input schema unspecified.");
  await expect(docs).toContainText("await tools.read");
  await page.getByRole("searchbox", { name: "Search tools" }).fill("Dynamically discovered");
  await expect(nav.getByRole("button")).toHaveCount(1);
  await expect(docs).toContainText("additionalProperties");
  await expect(docs).toContainText("Declared examples");
  await docs.getByRole("button", { name: "Copy display data" }).last().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{\n  "custom": "declared"\n}');
  await page.getByRole("searchbox", { name: "Search tools" }).fill("no match");
  await expect(nav).toContainText("No matching tools.");
  await expect(docs).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search tools" }).fill("Unnamed");
  await expect(docs).toContainText("No description supplied.");
});

test("declarations update and branch replacement clears stale search and selection", async ({ page }) => {
  await open(page);
  await page.getByRole("searchbox", { name: "Search tools" }).fill("write");
  current = [{ name: "write", description: "Updated description", parameters: { type: "boolean" } }];
  // Re-select a different branch; its tool collection must not retain prior documentation.
  await page.locator(`.session-primary:not([hidden]) [data-trace-id="${f.user}"]`).click();
  await page.getByRole("tab", { name: "tools", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search tools" })).toHaveValue("");
  await expect(page.getByRole("navigation", { name: "Declared tools" })).toContainText("No declared tools.");
  await page.locator(`.session-primary:not([hidden]) [data-trace-id="${f.assistant}"]`).click();
  await page.getByRole("tab", { name: "tools", exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected tool documentation" })).toContainText("Updated description");
});

test("historical replay documents Pi-generated returns and composed/typeless parameters accurately", async ({
  page,
}) => {
  const id = f.manager.appendMessage({
    role: "system",
    content: "",
    sections: {},
    timestamp: 7,
    toolsAdded: [
      ...runtimeToolDeclarations(),
      {
        name: "schema_cases",
        description: "Schema regression cases",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            typeless: { properties: { label: { type: "string" } } },
            arrayShape: { items: { type: "string" } },
            conditional: {
              type: "object",
              properties: { maybe: { type: "string" } },
              anyOf: [{ required: ["maybe"] }, {}],
            },
          },
          allOf: [{ allOf: [{ required: ["path"] }] }],
        },
      },
    ],
  });
  current = undefined;
  await open(page, id);
  const nav = page.getByRole("navigation", { name: "Declared tools" });
  const docs = page.getByRole("region", { name: "Selected tool documentation" });
  for (const name of ["read", "bash", "edit"]) {
    await nav.getByRole("button", { name: new RegExp(`^${name} `) }).click();
    await expect(docs.getByRole("heading", { name: "Returns", exact: true })).toBeVisible();
    await expect(docs).toContainText(`tools.${name}(args)\``);
  }
  await expect(
    docs
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Returns", exact: true }) })
      .locator("pre"),
  ).toHaveText("a string");
  await nav.getByRole("button", { name: /^schema_cases / }).click();
  await expect(docs.getByRole("row", { name: "path string Yes", exact: true })).toBeVisible();
  await expect(docs.getByRole("row", { name: "typeless unspecified No", exact: true })).toBeVisible();
  await expect(docs.getByRole("row", { name: "arrayShape unspecified No", exact: true })).toBeVisible();
  await docs.getByRole("button", { name: "conditional", exact: true }).click();
  await expect(docs.getByRole("row", { name: "maybe string Unknown", exact: true })).toBeVisible();
  await docs.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await expect(docs.locator(".json-tree")).toContainText("Schema regression cases");
});

test("wide Details keeps tool navigation beside documentation in both appearances", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await open(page);
  await page.getByRole("separator", { name: "Resize event details" }).focus();
  await page.keyboard.press("End");
  const bounds = await page.locator(".tool-browser").evaluate((element) => {
    const navigation = element.querySelector("nav")?.getBoundingClientRect();
    const documentation = element.querySelector(".tool-documentation")?.getBoundingClientRect();
    return { navigationRight: navigation?.right, documentationLeft: documentation?.left };
  });
  expect(bounds.navigationRight).toBeLessThan(bounds.documentationLeft ?? 0);
  await page.screenshot({ path: test.info().outputPath("tools-wide-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page
    .getByRole("navigation", { name: "Declared tools" })
    .getByRole("button", { name: /^update_progress / })
    .click();
  const docs = page.getByRole("region", { name: "Selected tool documentation" });
  await docs.getByRole("button", { name: "steps", exact: true }).click();
  await docs.getByRole("button", { name: "items []", exact: true }).click();
  await expect(docs).toContainText('"pending","in_progress","completed","blocked"');
  await page.screenshot({ path: test.info().outputPath("tools-wide-dark.png"), animations: "disabled" });
});

for (const width of [375, 1280]) {
  test(`compact layout at ${width}px keeps long names and content inside Details`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.getByRole("searchbox", { name: "Search tools" }).fill("Dynamically");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.locator(".tool-inspector").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`tools-${width}.png`), animations: "disabled" });
  });
}
