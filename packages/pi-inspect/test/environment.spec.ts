import { expect, type Page, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import type { Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let value: Snapshot;
test.beforeEach(async () => {
  f = fixture();
  const collector = new Collector();
  value = snapshot(f.manager, collector, "environment", 0, "current prompt", tools, ["read"], skills);
  value.mcp = { servers: [{ name: "registered-with-no-tools", truncated: false }], truncated: false };
  server = await startServer({
    generation: "environment",
    signal: new AbortController().signal,
    snapshot: () => value,
    branch: (id, offset) => branch(f.manager, id, offset, skills),
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
});
test.afterEach(async () => server.close());
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const resource = (page: Page) => page.locator(".resource-panel:not([hidden])");

for (const width of [1672, 1115, 900, 375]) {
  test(`two navigation levels, resource state and safe rendering at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(server.origin)) external.push(request.url());
    });
    const firstTool = value.tools[0];
    if (!firstTool) throw Error("Missing tool fixture");
    value.tools[0] = {
      ...firstTool,
      name: "long-".repeat(100),
      description: "<script>window.unsafe=true</script>",
      metadataTruncated: true,
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.url);
    const primary = page.getByRole("tablist", { name: "Inspection source" });
    await expect(primary.getByRole("tab")).toHaveText(["Context", "Session", "Cache", "Environment"]);
    const header = await page.locator(".app-header").boundingBox();
    const tabs = await primary.boundingBox();
    expect(tabs?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
    await expect(page.locator(".environment-surface .inventory-card")).toHaveCount(0);
    await tab(page, "Context").focus();
    await page.keyboard.press("End");
    await expect(tab(page, "Environment")).toBeFocused();
    await expect(tab(page, "Environment")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Context")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Environment")).toBeFocused();
    const secondary = page.getByRole("tablist", { name: "Environment resources" });
    await expect(secondary.getByRole("tab")).toHaveText(["Tools", "MCP Servers", "Skills"]);
    await expect(resource(page)).toContainText("active ≠ provider-visible");
    await expect(resource(page)).toContainText("<script>window.unsafe=true</script>");
    await expect(resource(page)).toContainText("Tool metadata truncated");
    await expect(resource(page).locator("script")).toHaveCount(0);
    await tab(page, "Tools").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "MCP Servers")).toBeFocused();
    await expect(tab(page, "Environment")).toHaveAttribute("aria-selected", "true");
    await expect(resource(page)).toContainText("registered-with-no-tools");
    await expect(resource(page)).toContainText("Connection status: unavailable");
    await expect(resource(page)).not.toContainText("mcp__docs__search");
    await page.keyboard.press("End");
    await expect(tab(page, "Skills")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab(page, "Tools")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Skills")).toBeFocused();
    await expect(resource(page)).toContainText("Skill content unavailable");
    await resource(page).getByRole("button", { name: "Path · example", exact: true }).click();
    await expect(resource(page)).toContainText("/skills/example/SKILL.md");
    await tab(page, "Session").click();
    await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tab(page, "Environment").click();
    await expect(tab(page, "Skills")).toHaveAttribute("aria-selected", "true");
    await expect(resource(page).getByRole("button", { name: "Path · example", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await tab(page, "Tools").click();
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
    for (const name of ["Tools", "MCP Servers", "Skills"]) {
      await tab(page, name).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`environment-${name.replaceAll(" ", "-").toLowerCase()}.png`),
        animations: "disabled",
      });
    }
    expect(f.manager.getLeafId()).toBe(value.leafId);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}

test("empty, partial, duplicate and unavailable resource catalogs never imply missing servers or files", async ({
  page,
}) => {
  value.tools = [];
  value.skills = [];
  value.mcp = { servers: [], truncated: false };
  await page.goto(server.url);
  await tab(page, "Environment").click();
  await expect(resource(page)).toContainText("No tools in this snapshot");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("This does not mean no MCP servers exist");
  await tab(page, "Skills").click();
  await expect(resource(page)).toContainText("No skills in the startup catalog");
  const firstSkill = skills[0];
  if (!firstSkill) throw Error("Missing skill fixture");
  value = {
    ...value,
    incomplete: true,
    skills: [firstSkill, { ...firstSkill, path: "/missing/SKILL.md" }],
    mcp: { servers: [], truncated: false, unavailable: true },
  };
  server.invalidate(1);
  await expect(page.locator(".environment-heading")).toContainText("Snapshot incomplete");
  await expect(resource(page).locator(".inventory-card")).toHaveCount(2);
  await expect(resource(page)).toContainText("not verified file availability");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("MCP registration API unavailable");
  value = { ...value, mcp: { servers: [{ name: "x".repeat(512), truncated: true }], truncated: true } };
  server.invalidate(2);
  await expect(resource(page)).toContainText("catalog truncated to 256");
  await expect(resource(page)).toContainText("Server name truncated");
  await server.close();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(resource(page)).toContainText("Connection status: unavailable");
});

test("loading and terminal errors leave resource availability explicit", async ({ page }) => {
  await page.route("**/api/snapshot?**", (route) => route.fulfill({ status: 409, body: "Changed" }));
  await page.goto(server.url);
  await tab(page, "Environment").click();
  await expect(page.getByText("Session expired; open a new viewer from Pi.", { exact: true })).toBeVisible();
  await expect(page.locator(".environment-heading")).toContainText("Resource inventory unavailable");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("complete configured server catalog is unavailable");
});

test("Environment exit cancels pending event work; desktop and drawer share one selection", async ({ page }) => {
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("/api/detail") });
  await page.route("**/api/detail?**", async (route) => {
    ready();
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(server.url);
    await tab(page, "Session").click();
    await page.locator(`.session-primary:not([hidden]) [data-trace-id="${f.user}"]`).click();
    await admitted;
    await tab(page, "Environment").click();
    release();
    await aborted;
    await expect(page.locator(".inspector-panel")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.unroute("**/api/detail?**");
    await tab(page, "Session").click();
    await expect(page.locator(".recorded-content")).toContainText("first request");
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.getByRole("dialog", { name: "Event details", exact: true })).toBeVisible();
    await expect(page.locator(".inspector-panel")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
    await tab(page, "Environment").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tab(page, "Session").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle event details" }).click();
    await expect(page.locator(".recorded-content")).toContainText("first request");
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".inspector-panel")).toHaveCount(1);
    await page.getByRole("button", { name: "Close event details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
  } finally {
    release();
  }
});
