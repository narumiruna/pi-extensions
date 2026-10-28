import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { expect, type Page, test } from "@playwright/test";
import { Type } from "typebox";
import { Collector } from "../src/collector.js";
import type { Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let catalog: ToolInfo[];
let active: string[];
let value: Snapshot;
let revision: number;
const source: ToolInfo["sourceInfo"] = {
  source: "local",
  path: "/extensions/local.ts",
  scope: "temporary",
  origin: "top-level",
};
function tool(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
  const template = tools[0];
  if (!template) throw Error("Missing tool fixture");
  return { ...template, name, description: `Description for ${name}`, sourceInfo: source, ...overrides };
}
function project() {
  value = snapshot(f.manager, new Collector(), "tool-explorer", revision, "Current prompt", catalog, active, skills);
}
function refresh() {
  revision++;
  project();
  server.invalidate(revision);
}
test.beforeEach(async () => {
  f = fixture();
  revision = 0;
  active = ["read"];
  catalog = [
    tool("read", { sourceInfo: { ...source, source: "builtin", path: "builtin:read" } }),
    tool("search_docs", {
      exposure: "codemode",
      namespace: { name: "mcp__docs" },
      sourceInfo: {
        ...source,
        source: "npm:docs",
        origin: "package",
        baseDir: "/packages/docs",
        path: "/packages/docs/search.ts",
      },
    }),
    tool("fetch_docs", {
      exposure: "deferred",
      namespace: { name: "mcp__docs" },
      sourceInfo: {
        ...source,
        source: "npm:docs",
        origin: "package",
        baseDir: "/packages/docs",
        path: "/packages/docs/fetch.ts",
      },
    }),
    tool("local_review", { exposure: "hidden" }),
    tool("mcp__pretend__name", { exposure: "model-only", sourceInfo: undefined as unknown as ToolInfo["sourceInfo"] }),
  ];
  project();
  const collector = new Collector();
  server = await startServer({
    generation: "tool-explorer",
    signal: new AbortController().signal,
    snapshot: () => value,
    branch: (leaf, offset) => branch(f.manager, leaf, offset, skills),
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
});
test.afterEach(async () => server.close());
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const inventory = (page: Page) => page.getByRole("region", { name: "Scrollable tools table" });
const inspect = (page: Page, name: string) =>
  inventory(page).getByRole("button", { name: `Inspect ${name}`, exact: true });
const details = (page: Page) => page.getByRole("complementary", { name: "Tool details", exact: true });
async function open(page: Page, width = 1672) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(server.url);
  await tab(page, "Tools").click();
  await expect(inventory(page).locator("tbody tr")).toHaveCount(catalog.length);
}
async function bounded(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
}

test("source navigation separates public namespaces, packages, builtin and unknown provenance", async ({ page }) => {
  await open(page);
  const sources = page.getByRole("navigation", { name: "Tool sources" });
  await expect(sources.locator("summary")).toHaveText(["Built-in1", "Namespaces2", "Extensions1", "Unknown1"]);
  await expect(page.getByRole("combobox", { name: "Group tools by" }).locator("option")).toHaveText([
    "Namespace",
    "Source",
    "Exposure",
  ]);
  await expect(inventory(page).locator("tbody tr")).toHaveText([
    "readdirectEligibleYes",
    "search_docscodemodeEligibleNo",
    "fetch_docsdeferredEligibleNo",
    "local_reviewhiddenNoNo",
    "mcp__pretend__namemodel-onlyNoNo",
  ]);
  await sources.getByRole("button", { name: "mcp__docs 2", exact: true }).click();
  await expect(inventory(page).locator("tbody tr")).toHaveCount(2);
  await expect(inventory(page).getByRole("button")).toHaveText(["search_docs", "fetch_docs"]);
  await expect(page.locator(".tool-breadcrumb")).toHaveText("mcp__docs2 / 5 tools");
  await sources.getByRole("button", { name: "Unknown source 1", exact: true }).click();
  await expect(inventory(page).getByRole("button")).toHaveText(["mcp__pretend__name"]);
  await expect(sources).not.toContainText("mcp__pretend");
  await page.getByRole("combobox", { name: "Group tools by" }).selectOption("source");
  await expect(sources.locator("summary")).toHaveText(["Built-in1", "Extensions1", "Packages2", "Unknown1"]);
  await expect(sources.getByRole("button", { name: "mcp__docs 2", exact: true })).toHaveCount(0);
  await sources.getByRole("button", { name: "npm:docs 2", exact: true }).click();
  await expect(inventory(page).getByRole("button")).toHaveText(["search_docs", "fetch_docs"]);
  await page.getByRole("combobox", { name: "Group tools by" }).selectOption("exposure");
  await expect(sources.getByRole("heading", { name: "Exposure groups" })).toBeVisible();
  await expect(inventory(page).locator("tbody tr")).toHaveCount(5);
  await sources.getByRole("button", { name: "deferred 1", exact: true }).click();
  await expect(inventory(page).getByRole("button")).toHaveText(["fetch_docs"]);
  await sources.getByRole("button", { name: "All tools 5", exact: true }).click();
  await expect(inventory(page).locator("tbody tr")).toHaveCount(5);
  await page.getByRole("combobox", { name: "Group tools by" }).selectOption("source");
  await sources.getByRole("button", { name: "Unknown source 1", exact: true }).click();
  catalog = catalog.filter((entry) => entry.name !== "mcp__pretend__name");
  refresh();
  await expect(sources.getByRole("button", { name: "All tools 4", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(inventory(page).locator("tbody tr")).toHaveCount(4);
  expect(f.manager.getLeafId()).toBe(value.leafId);
});

for (const width of [320, 1672]) {
  test(`namespace labels include non-MCP tools and source fallbacks at ${width}px`, async ({ page }) => {
    const mcp = catalog.find((entry) => entry.name === "search_docs");
    if (!mcp) throw Error("Missing MCP fixture");
    catalog = [
      tool("native_search", { namespace: { name: "github" } }),
      mcp,
      tool("local_review"),
      { ...mcp, name: "package_review", namespace: undefined },
    ];
    project();
    await open(page, width);
    if (width === 320) await page.getByRole("button", { name: "Sources", exact: true }).click();
    const sources = page.getByRole("navigation", { name: "Tool sources" });
    await expect(sources.locator("summary")).toHaveText(["Namespaces2", "Extensions1", "Packages1"]);
    const namespaces = sources
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Namespaces2$/ }) });
    await expect(namespaces.getByRole("button")).toHaveText(["github1", "mcp__docs1"]);
    await sources.getByRole("button", { name: "github 1", exact: true }).click();
    await expect(inventory(page).getByRole("button")).toHaveText(["native_search"]);
    if (width === 320) await page.getByRole("button", { name: "Sources", exact: true }).click();
    await sources.getByRole("button", { name: "npm:docs 1", exact: true }).click();
    await expect(inventory(page).getByRole("button")).toHaveText(["package_review"]);
    await bounded(page);
  });
}

test("Columns retains required Name and combines source, search and exposure filters", async ({ page }) => {
  await open(page);
  const columns = page.locator(".tool-columns-menu");
  const columnsTrigger = page.getByRole("button", { name: "Columns", exact: true });
  await columnsTrigger.click();
  const name = columns.getByRole("checkbox", { name: "Name (required)", exact: true });
  await expect(name).toBeChecked();
  await expect(name).toBeDisabled();
  for (const label of ["Exposure", "Codemode", "Active"])
    await columns.getByRole("checkbox", { name: label, exact: true }).uncheck();
  await expect(inventory(page).getByRole("columnheader")).toHaveText(["Name"]);
  for (const label of ["Source", "Namespace", "Description"])
    await columns.getByRole("checkbox", { name: label, exact: true }).check();
  await expect(inventory(page).getByRole("columnheader")).toHaveText(["Name", "Source", "Namespace", "Description"]);
  await page.keyboard.press("Escape");
  await expect(columns).toHaveCount(0);
  await expect(columnsTrigger).toBeFocused();
  await page.getByRole("searchbox", { name: "Search tools" }).fill("NPM:DOCS");
  await expect(inventory(page).locator("tbody tr")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Filter tool exposure" }).selectOption("codemode");
  await expect(inventory(page).getByRole("button")).toHaveText(["search_docs"]);
  await page.getByRole("combobox", { name: "Filter tool exposure" }).selectOption("hidden");
  await expect(inventory(page).locator("tbody tr")).toHaveCount(0);
  await expect(inventory(page).getByRole("status")).toHaveText("No tools match these filters.");
  await page.getByRole("searchbox", { name: "Search tools" }).fill("");
  await expect(inventory(page).getByRole("button")).toHaveText(["local_review"]);
  await page.getByRole("combobox", { name: "Filter tool exposure" }).selectOption("all");
  await page
    .getByRole("navigation", { name: "Tool sources" })
    .getByRole("button", { name: "mcp__docs 2", exact: true })
    .click();
  await page.getByRole("searchbox", { name: "Search tools" }).fill("no such tool");
  await expect(inventory(page).getByRole("status")).toHaveText("No tools match these filters.");
  await bounded(page);
});

test("one persistent selection survives metadata refresh, reorder and grouping but not removal", async ({ page }) => {
  await open(page);
  await expect(details(page)).toHaveCount(0);
  await inspect(page, "search_docs").click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).locator(".json-tree")).toHaveCount(0);
  await tab(page, "Parameters").click();
  await expect(details(page).getByRole("tabpanel", { name: "Parameters", exact: true })).toContainText("path");
  const schema = details(page).getByRole("button", { name: "Schema · search_docs", exact: true });
  await schema.click();
  await expect(details(page).locator(".json-tree")).toHaveCount(1);
  const selectedId = value.tools.find((entry) => entry.name === "search_docs")?.catalogId;
  catalog = catalog
    .map<ToolInfo>((entry) =>
      entry.name === "search_docs"
        ? {
            ...entry,
            description: "Refreshed description",
            exposure: "hidden",
            parameters: Type.Object({ refreshed: Type.Boolean() }),
          }
        : entry,
    )
    .reverse();
  refresh();
  await expect(details(page)).toContainText("hidden");
  expect(value.tools.find((entry) => entry.name === "search_docs")?.catalogId).toBe(selectedId);
  await expect(schema).toHaveAttribute("aria-expanded", "true");
  await expect(details(page).locator(".json-tree")).toContainText("refreshed");
  await expect(inspect(page, "search_docs")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Group tools by" }).selectOption("source");
  await expect(schema).toHaveAttribute("aria-expanded", "true");
  await tab(page, "Overview").click();
  await expect(details(page)).toContainText("Refreshed description");
  await page.getByRole("searchbox", { name: "Search tools" }).fill("read");
  await expect(details(page)).toContainText("search_docs");
  catalog = catalog.filter((entry) => entry.name !== "search_docs");
  refresh();
  await expect(details(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show tool details", exact: true })).toHaveCount(0);
  await expect(inventory(page).locator('[aria-pressed="true"]')).toHaveCount(0);
});

test("colliding projected display labels keep distinct catalog IDs, source filters and selections", async ({
  page,
}) => {
  catalog = ["\u001b[31msame", "\u001b[32msame"].map((raw, index) =>
    tool(raw, {
      description: `Distinct tool ${index}`,
      namespace: { name: raw },
      sourceInfo: { ...source, path: raw },
    }),
  );
  project();
  expect(value.tools[0]?.catalogId).not.toBe(value.tools[1]?.catalogId);
  expect(value.tools.map((entry) => entry.name)).toEqual(["same", "same"]);
  await open(page);
  const buttons = inspect(page, "same");
  await expect(buttons).toHaveCount(2);
  await buttons.nth(0).click();
  await expect(details(page)).toContainText("Distinct tool 0");
  await buttons.nth(1).click();
  await expect(details(page)).toContainText("Distinct tool 1");
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
  catalog.reverse();
  refresh();
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(details(page)).toContainText("Distinct tool 1");
  for (const grouping of ["namespace", "source"]) {
    await page.getByRole("combobox", { name: "Group tools by" }).selectOption(grouping);
    const groups = page
      .getByRole("navigation", { name: "Tool sources" })
      .getByRole("button", { name: "same 1", exact: true });
    await expect(groups).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await groups.nth(index).click();
      await expect(buttons).toHaveCount(1);
      await buttons.click();
      await expect(details(page)).toContainText(`Distinct tool ${1 - index}`);
    }
  }
});

for (const width of [320, 900, 1100]) {
  test(`both narrow drawers restore focus and release portals on navigation at ${width}px`, async ({ page }) => {
    await open(page, width);
    const sourceTrigger = page.getByRole("button", { name: "Sources", exact: true });
    const sourceDrawer = page.getByRole("dialog", { name: "Tool sources", exact: true });
    const detailDrawer = page.getByRole("dialog", { name: "Tool details", exact: true });
    for (const close of ["escape", "button", "selection"]) {
      await sourceTrigger.click();
      await expect(sourceDrawer).toBeVisible();
      expect(await sourceDrawer.evaluate((element) => element.closest(".inspector-app"))).toBeNull();
      if (close === "escape") await page.keyboard.press("Escape");
      else if (close === "button")
        await sourceDrawer.getByRole("button", { name: "Close Tool sources", exact: true }).click();
      else await sourceDrawer.getByRole("button", { name: "mcp__docs 2", exact: true }).click();
      await expect(sourceDrawer).toHaveCount(0);
      await expect(sourceTrigger).toBeFocused();
    }
    await expect(inventory(page).locator("tbody tr")).toHaveCount(2);
    const trigger = inspect(page, "search_docs");
    for (const close of ["escape", "button"]) {
      await trigger.click();
      await expect(detailDrawer).toBeVisible();
      if (close === "escape" && width === 320) {
        await page.screenshot({
          path: test.info().outputPath("tool-explorer-mobile-details.png"),
          animations: "disabled",
        });
      }
      expect(await detailDrawer.evaluate((element) => element.closest(".inspector-app"))).toBeNull();
      await detailDrawer.getByRole("button", { name: "Close Tool details", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(detailDrawer.getByRole("tab", { name: "Overview", exact: true })).toBeFocused();
      await bounded(page);
      if (close === "escape") await page.keyboard.press("Escape");
      else await detailDrawer.getByRole("button", { name: "Close Tool details", exact: true }).click();
      await expect(detailDrawer).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    for (const drawer of ["sources", "details"]) {
      for (const destination of ["Context", "Session", "Cache", "MCP Servers", "Skills"]) {
        await (drawer === "sources" ? sourceTrigger : trigger).click();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        // A host navigation can replace the active pane while a modal owns pointer focus.
        await page.getByRole("tab", { name: destination, exact: true, includeHidden: true }).dispatchEvent("click");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.locator(".side-drawer")).toHaveCount(0);
        await tab(page, "Tools").click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    }
    expect(f.manager.getLeafId()).toBe(value.leafId);
  });
}

test("resize transfers one selected tool between desktop aside and narrow dialog without orphaned drawers", async ({
  page,
}) => {
  await open(page, 1672);
  await inspect(page, "search_docs").click();
  await expect(details(page)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("tool-explorer-desktop-three-pane.png"),
    animations: "disabled",
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1101, height: 900 });
  await expect(details(page)).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 900 });
  const drawer = page.getByRole("dialog", { name: "Tool details", exact: true });
  await expect(drawer).toBeVisible();
  await expect(details(page)).toHaveCount(0);
  await expect(drawer).toContainText("search_docs");
  await page.screenshot({ path: test.info().outputPath("tool-explorer-narrow-details.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(details(page)).toContainText("search_docs");
  await page.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect(inspect(page, "search_docs")).toBeFocused();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tool sources", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Tool sources" })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await bounded(page);
});

for (const width of [375, 1672]) {
  test(`hostile projected metadata stays literal, bounded and inert at ${width}px`, async ({ page, context }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(server.origin)) external.push(request.url());
    });
    const rawName = `\u001b[31m<script>window.unsafe=true</script>${"long_name_".repeat(100)}`;
    catalog = [
      tool(rawName, {
        description: '<img src="https://invalid.example/pixel" onerror="window.unsafe=true">',
        namespace: { name: `\u001b[32m${"namespace_".repeat(100)}` },
        sourceInfo: { ...source, path: `<svg onload="window.unsafe=true">${"path/".repeat(200)}` },
        parameters: Type.Object({ "<script>unsafe</script>": Type.String({ description: "Literal parameter" }) }),
      }),
    ];
    project();
    const name = value.tools[0]?.name;
    if (!name) throw Error("Missing projected name");
    await open(page, width);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    await inspect(page, name).click();
    const panel = width > 1100 ? details(page) : page.getByRole("dialog", { name: "Tool details", exact: true });
    await expect(panel).toContainText(catalog[0]?.description ?? "");
    await expect(panel).toContainText("Tool metadata truncated");
    await expect(panel.locator("script, img, svg[onload]")).toHaveCount(0);
    await panel.getByRole("tab", { name: "Parameters", exact: true }).click();
    await expect(panel).toContainText("<script>unsafe</script>");
    const schema = panel.locator(".data").last();
    await schema.getByRole("button", { name: "Copy display data", exact: true }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(value.tools[0]?.schema.value);
    await bounded(page);
    await panel.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(panel.locator(".json-tree")).toContainText("<svg onload=");
    await bounded(page);
    expect(await page.evaluate(() => "unsafe" in window)).toBe(false);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(f.manager.getLeafId()).toBe(value.leafId);
  });
}
