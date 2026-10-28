import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { expect, type Page, test } from "@playwright/test";
import { Type } from "typebox";
import { Collector } from "../src/collector.js";
import type { Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

const longPath =
  "/home/narumi/.herdr/worktrees/pi-extensions/worktree-rapid-stone-92f6/packages/pi-subagents/src/index.ts";
const otherPath = "/another/worktree/packages/pi-subagents/src/index.ts";
const shortLabel = "…/pi-subagents/src/index.ts";
let server: ViewerServer;
let catalog: ToolInfo[];
let value: Snapshot;
let project: () => void;
test.beforeEach(async () => {
  const f = fixture();
  const collector = new Collector();
  const template = tools[0];
  if (!template) throw Error("Missing tool fixture");
  catalog = [
    {
      ...template,
      sourceInfo: { ...template.sourceInfo, source: "builtin", path: "builtin:read" },
      parameters: Type.Object({
        options: Type.Object({ limit: Type.Number() }),
        ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field_${i}`, Type.String()])),
      }),
    },
    { ...template, name: "local_review", sourceInfo: { ...template.sourceInfo, path: longPath } },
    { ...template, name: "other_review", sourceInfo: { ...template.sourceInfo, path: otherPath } },
  ];
  let revision = -1;
  let initialized = false;
  project = () => {
    value = snapshot(f.manager, collector, "explorer-regressions", ++revision, "Prompt", catalog, ["read"], skills);
    if (initialized) server.invalidate(revision);
  };
  project();
  server = await startServer({
    generation: "explorer-regressions",
    signal: new AbortController().signal,
    snapshot: () => value,
    branch: (id, offset) => branch(f.manager, id, offset, skills),
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
  initialized = true;
});
test.afterEach(async () => server.close());
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const table = (page: Page) => page.getByRole("region", { name: "Scrollable tools table" });
const inspect = (page: Page, name: string) => table(page).getByRole("button", { name: `Inspect ${name}`, exact: true });
async function open(page: Page, width = 1672, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(server.url);
  await tab(page, "Tools").click();
  await expect(table(page).locator("tbody tr")).toHaveCount(catalog.length);
}
async function bounded(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
}

for (const viewport of [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
  { width: 1115, height: 600 },
  { width: 375, height: 500 },
]) {
  test(`Columns stays operable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await open(page, viewport.width, viewport.height);
    const trigger = page.getByRole("button", { name: "Columns", exact: true });
    const menu = page.getByRole("dialog", { name: "Visible tool columns", exact: true });
    for (const appearance of ["light", "dark"]) {
      if (appearance === "dark") await page.getByRole("button", { name: "Toggle appearance" }).click();
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS(
        "background-color",
        appearance === "light" ? "rgb(250, 248, 243)" : "rgb(38, 41, 46)",
      );
      await expect(menu).toHaveCSS("font-family", /monospace/);
      await expect
        .poll(async () => {
          const box = await menu.boundingBox();
          return Boolean(
            box &&
              box.x >= 7 &&
              box.y >= 7 &&
              box.x + box.width <= viewport.width - 7 &&
              box.y + box.height <= viewport.height - 7,
          );
        })
        .toBe(true);
      await expect(menu.getByRole("checkbox", { name: "Name (required)", exact: true })).toBeDisabled();
      for (const name of ["Exposure", "Codemode", "Active", "Source", "Namespace", "Description"]) {
        const checkbox = menu.getByRole("checkbox", { name, exact: true });
        const before = await checkbox.isChecked();
        await checkbox.click();
        await expect(checkbox).toBeChecked({ checked: !before });
      }
      const last = menu.getByRole("checkbox", { name: "Description", exact: true });
      await last.focus();
      const before = await last.isChecked();
      await page.keyboard.press("Space");
      await expect(last).toBeChecked({ checked: !before });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await bounded(page);
    }
    await trigger.click();
    await tab(page, "Skills").dispatchEvent("click");
    await expect(menu).toHaveCount(0);
    await expect(tab(page, "Skills")).toHaveAttribute("aria-selected", "true");
  });
}

test("Columns repositions during resize and closes on main navigation", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Visible tool columns", exact: true });
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(menu).toBeVisible();
  const last = menu.getByRole("checkbox", { name: "Description", exact: true });
  await last.check();
  await expect(last).toBeChecked();
  await tab(page, "Session").dispatchEvent("click");
  await expect(menu).toHaveCount(0);
  await tab(page, "Tools").click();
  await expect(menu).toHaveCount(0);
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 375, height: 500 },
  { width: 1115, height: 600 },
  { width: 1672, height: 900 },
]) {
  test(`long source labels retain tool rows at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await open(page, viewport.width, viewport.height);
    if (viewport.width <= 1100) await page.getByRole("button", { name: "Sources", exact: true }).click();
    const sources = page.getByRole("navigation", { name: "Tool sources" });
    await expect(sources.getByRole("button", { name: `${shortLabel} 1`, exact: true })).toHaveCount(2);
    await sources.getByTitle(longPath, { exact: true }).click();
    await expect(table(page).locator("tbody tr")).toHaveCount(1);
    const breadcrumb = page.locator(".tool-breadcrumb strong");
    await expect(breadcrumb).toHaveText(shortLabel);
    await expect(breadcrumb).toHaveAttribute("title", longPath);
    expect((await breadcrumb.boundingBox())?.height).toBeLessThan(25);
    expect((await table(page).boundingBox())?.height).toBeGreaterThanOrEqual(100);
    await expect(inspect(page, "local_review")).toBeInViewport({ ratio: 1 });
    await inspect(page, "local_review").click();
    const panel =
      viewport.width > 1100
        ? page.getByRole("complementary", { name: "Tool details", exact: true })
        : page.getByRole("dialog", { name: "Tool details", exact: true });
    await panel.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(panel.locator(".json-tree")).toContainText(longPath);
    await bounded(page);
  });
}

test("detail tabs, disclosures, formats, parameter rows and scroll survive resize and reopening", async ({ page }) => {
  await open(page);
  await inspect(page, "read").click();
  await tab(page, "Parameters").click();
  const content = page.locator(".tool-detail-content");
  const options = page.getByRole("button", { name: "options", exact: true });
  await options.click();
  await expect(options).toHaveAttribute("aria-expanded", "true");
  const schema = page.getByRole("button", { name: "Schema · read", exact: true });
  await schema.click();
  await page.getByRole("button", { name: "JSON text", exact: true }).click();
  await content.evaluate((el) => {
    el.scrollTop = 180;
  });
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(180);
  for (const width of [900, 1400, 1100, 1672]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 1100) await expect(page.getByRole("dialog", { name: "Tool details", exact: true })).toBeVisible();
    else await expect(page.getByRole("complementary", { name: "Tool details", exact: true })).toBeVisible();
    await expect(tab(page, "Parameters")).toHaveAttribute("aria-selected", "true");
    await expect(options).toHaveAttribute("aria-expanded", "true");
    await expect(schema).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "JSON text", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(180);
  }
  await tab(page, "Source").click();
  const source = page.getByRole("button", { name: "Source · read", exact: true });
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "JSON text", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "JSON text", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Show tool details", exact: true }).click();
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await inspect(page, "other_review").click();
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Schema · other_review", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

for (const width of [900, 1672]) {
  test(`each detail opener restores focus or uses a visible fallback at ${width}px`, async ({ page }) => {
    await open(page, width);
    const close = async () => {
      if (width <= 1100) await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Close tool details", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Tool details", exact: true })).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "Tool details", exact: true })).toHaveCount(0);
    };
    await inspect(page, "read").click();
    await close();
    await expect(inspect(page, "read")).toBeFocused();
    const reopen = page.getByRole("button", { name: "Show tool details", exact: true });
    for (let i = 0; i < 2; i++) {
      await reopen.click();
      await close();
      await expect(reopen).toBeFocused();
    }
    await inspect(page, "read").click();
    if (width > 1100) await page.getByRole("searchbox", { name: "Search tools" }).fill("other_review");
    else {
      // A catalog update can remove a row while the drawer owns focus.
      catalog = catalog.filter((tool) => tool.name !== "read");
      project();
    }
    if (width > 1100) await close();
    await expect(page.getByRole("dialog", { name: "Tool details", exact: true })).toHaveCount(0);
    const focused = width > 1100 ? reopen : page.getByRole("searchbox", { name: "Search tools" });
    await expect(focused).toBeFocused();
    await bounded(page);
  });
}
