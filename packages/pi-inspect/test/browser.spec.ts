import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, type Page, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

let server: ViewerServer;
let data: ReturnType<typeof fixture>;
let collector: Collector;
let revision = 0;
test.beforeEach(async () => {
  data = fixture();
  collector = new Collector();
  revision = 0;
  server = await startServer({
    generation: "browser-fixture",
    signal: new AbortController().signal,
    snapshot: () =>
      snapshot(data.manager, collector, "browser-fixture", revision, "current runtime prompt", tools, ["read"], skills),
    branch: (leaf, offset) => branch(data.manager, leaf, offset, skills),
    detail: (id, leaf) => detail(data.manager, id, leaf, collector),
  });
});
test.afterEach(async () => {
  await server.close();
});
async function explore(page: Page): Promise<void> {
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("tab", { name: "Branch view", exact: true }).click();
  if ((page.viewportSize()?.width ?? 0) >= 1200) {
    await page.getByRole("button", { name: "Toggle event details", exact: true }).click();
    await page.getByRole("tab", { name: "raw", exact: true }).click();
  }
}
const nav = (page: Page, id: string) => page.locator(`.session-primary:not([hidden]) [data-trace-id="${id}"]`);
const row = nav;
async function openLive(page: Page) {
  await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
}
async function openObjects(page: Page, section: string) {
  const container = page
    .locator(".inspector-panel .data")
    .filter({ has: page.getByRole("button", { name: section, exact: true }) });
  await container.locator(".json-object").evaluateAll((elements) => {
    for (const element of elements) (element as HTMLDetailsElement).open = true;
  });
}

test("compact links authenticate, clear fragments and survive reload; legacy links remain supported", async ({
  page,
}) => {
  expect(server.url.length).toBeLessThanOrEqual(68);
  await explore(page);
  await expect(page.locator(".session-primary:not([hidden]) .trace-panel [role=treeitem]").first()).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.reload();
  await expect(page.locator(".segment-row").first()).toBeVisible();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto("about:blank");
  await page.goto(`${server.origin}/#token=${server.token}&generation=browser-fixture`);
  await expect(page.locator(".segment-row").first()).toBeVisible();
});

test("existing prompt/tools/skills/context/codemode, filtering, read-only selection and narrow layout", async ({
  page,
}) => {
  const initialLeaf = data.manager.getLeafId();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await explore(page);
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(page.url()).not.toContain("token");
  await nav(page, data.alternate).click();
  await expect(page.locator(".inspector-identity")).toContainText(data.alternate);
  expect(data.manager.getLeafId()).toBe(initialLeaf);
  await page.getByRole("tab", { name: "prompt", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Historical prompt · browser preview branch", exact: true }),
  ).toBeVisible();
  await nav(page, data.delta).click();
  await expect(page.getByText("+ changed", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "tools", exact: true }).click();
  await expect(page.getByRole("region", { name: "Historical declared tools", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Declared tools" })).toContainText("No declared tools.");
  await expect(page.locator(".inspector-panel .inventory-card")).toHaveCount(0);
  await page.getByRole("tab", { name: "skills", exact: true }).click();
  await openObjects(page, "Evidence on preview branch");
  await expect(page.getByText('"successfully read (nested metadata)"', { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "context", exact: true }).click();
  await expect(page.getByRole("button", { name: "Projected branch entries", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "raw", exact: true }).click();
  await page.getByRole("textbox", { name: "Search session" }).fill("Alternative");
  await expect(page.locator('.session-primary:not([hidden]) .trace-row[data-match="true"]')).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search session" }).fill("");
  await page.locator(".filter-panel > summary").click();
  await page.getByRole("combobox", { name: "Filter entry type" }).click();
  await page.getByRole("option", { name: "assistant", exact: true }).click();
  await expect(page.locator('.session-primary:not([hidden]) .trace-row[data-match="true"]')).toHaveCount(1);
  await nav(page, data.assistant).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "codemode", exact: true }).click();
  await expect(
    page.getByText('await tools.read({path:"/skills/example/SKILL.md"}); text("done")', { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator(".app-grid")).toHaveClass(/narrow-layout/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("true hierarchy, independent selection/disclosure, retained descendants, keyboard and inline objects", async ({
  page,
}) => {
  data.manager.branch(data.user);
  const root = data.manager.appendCustomEntry("Flow", { heading: "root" });
  const a = data.manager.appendCustomEntry("Stage A", { input: "value" });
  const b = data.manager.appendCustomEntry("Stage B", { nested: { deeper: { answer: 42 } } });
  const c = data.manager.appendCustomEntry("Stage C", { output: "done" });
  data.manager.branch(root);
  const sibling = data.manager.appendCustomEntry("Sibling", { marker: true });
  data.manager.branch(c);
  const initial = data.manager.getLeafId();
  await explore(page);
  await expect(row(page, c)).toBeVisible();
  await expect(page.locator(`.session-primary:not([hidden]) [data-trace-entry-id="${c}"]`)).toHaveAttribute(
    "data-parent-id",
    b,
  );
  await expect(row(page, c)).toHaveAttribute("aria-level", "6");
  await page.getByRole("button", { name: `Expand event ${root}`, exact: true }).click();
  await expect(row(page, a)).toHaveCount(0);
  await expect(page.locator(".inspector-identity")).toContainText(c);
  await page.getByRole("button", { name: `Expand event ${root}`, exact: true }).click();
  await expect(row(page, c)).toBeVisible();
  await expect(row(page, a)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, sibling)).toBeVisible();
  await row(page, root).focus();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, a)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(nav(page, a)).toHaveAttribute("aria-current", "true");
  await expect(row(page, a)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(" ");
  await expect(row(page, b)).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(row(page, b)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, b)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, b)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  const inline = page.locator(`.session-primary:not([hidden]) [data-trace-entry-id="${b}"] .inline-entry`);
  await expect(inline.getByRole("button", { name: "Recorded content", exact: true })).toBeVisible();
  await inline.locator("summary").filter({ hasText: "nested" }).click();
  await inline.locator("summary").filter({ hasText: "deeper" }).click();
  await expect(inline.getByText("42", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Expand event ${root}`, exact: true }).click();
  await page.getByRole("button", { name: `Expand event ${root}`, exact: true }).click();
  await expect(inline.getByText("42", { exact: true })).toBeVisible();
  expect(data.manager.getLeafId()).toBe(initial);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("related navigation reveals a filtered-out child without clearing filters or expansion", async ({ page }) => {
  await explore(page);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await nav(page, data.assistant).click();
  await page.locator(".inspector-panel").getByRole("button", { name: "Related entries", exact: true }).click();
  await page
    .locator(".related")
    .getByRole("button", { name: `tool_result · ${data.result}`, exact: true })
    .click();
  await expect(row(page, data.result)).toBeVisible();
  await expect(row(page, data.result)).toHaveAttribute("aria-selected", "true");
  await expect(nav(page, data.result)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(".session-primary:not([hidden])").getByText("selected outside filters", { exact: true }),
  ).toBeVisible();
});

test("executions remain an explicit view during updates; hostile text/raster remains safe", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(server.origin)) external.push(request.url());
  });
  await explore(page);
  const drawer = page.getByRole("tab", { name: /^Captured executions ·/ });
  await expect(drawer).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".live-drawer")).not.toBeVisible();
  collector.start(
    {
      type: "tool_execution_start",
      toolCallId: "parent/1",
      parentToolCallId: "parent",
      toolName: "mcp__docs__search",
      args: { query: "<img src=https://evil.example/onload>" },
    },
    data.assistant,
  );
  server.invalidate(++revision);
  await expect(drawer).toContainText("1 running");
  await expect(drawer).toHaveAttribute("aria-selected", "false");
  await openLive(page);
  await page.getByRole("button", { name: "mcp__docs__search · running", exact: true }).click();
  collector.end(
    {
      type: "tool_execution_end",
      toolCallId: "parent/1",
      parentToolCallId: "parent",
      toolName: "mcp__docs__search",
      isError: true,
      durationMs: 4,
      result: {
        content: [
          { type: "text", text: "<script>globalThis.hacked=true</script>\u001b[31merror" },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXs8AAAAASUVORK5CYII=",
          },
        ],
      },
    },
    data.assistant,
  );
  server.invalidate(++revision);
  await expect(page.getByRole("button", { name: "mcp__docs__search · error", exact: true })).toBeVisible();
  await openObjects(page, "Result · observed tool event");
  await expect(page.getByText('"<script>globalThis.hacked=true</script>error"', { exact: true })).toBeVisible();
  await expect(page.getByAltText("Captured raster tool output")).toBeVisible();
  expect(await page.evaluate(() => "hacked" in globalThis)).toBe(false);
  expect(external).toEqual([]);
  await server.close();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
});

test("list is default; timeline uses a shared axis and log points, never duration-only spans", async ({ page }) => {
  collector.start({ type: "tool_execution_start", toolCallId: "timed", toolName: "read", args: {} }, data.assistant);
  collector.end(
    { type: "tool_execution_end", toolCallId: "timed", toolName: "read", isError: false, result: {}, durationMs: 50 },
    data.assistant,
  );
  collector.end(
    {
      type: "tool_execution_end",
      toolCallId: "unknown-start",
      toolName: "read",
      isError: false,
      result: {},
      durationMs: 10000,
    },
    data.assistant,
  );
  await explore(page);
  await expect(page.locator(".session-primary:not([hidden]) .trace-list")).toBeVisible();
  await expect(page.locator(".timeline-span")).toHaveCount(0);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.locator(".session-primary:not([hidden]) .trace-tree .timeline-point").first()).toBeVisible();
  await expect(page.locator(".session-primary:not([hidden]) .trace-tree .timeline-span")).toHaveCount(0);
  await openLive(page);
  await expect(page.locator('[data-raw-id="unknown-start"] .timeline-span')).toHaveCount(0);
  await expect(page.locator('[data-raw-id="unknown-start"] .timeline-point')).toBeVisible();
  await page.getByRole("tab", { name: "Branch view", exact: true }).click();
  await nav(page, data.alternate).click();
  await expect(page.locator(".session-primary:not([hidden]) .trace-timeline")).toBeVisible();
});

test("compact desktop layout, resizing/collapse, overview/JSON, copy and screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) =>
          Object.defineProperty(window, "copiedDisplay", { value: text, configurable: true }),
      },
    }),
  );
  await explore(page);
  await expect(page.getByRole("region", { name: "Session overview" })).toBeVisible();
  const positions = await page.locator(".center-column, .inspector-panel").evaluateAll((elements) =>
    elements.map((element) => ({
      x: element.getBoundingClientRect().x,
      width: element.getBoundingClientRect().width,
    })),
  );
  expect(positions[0]?.x).toBeLessThan(positions[1]?.x ?? 0);
  expect(positions[0]?.width).toBeGreaterThan(positions[1]?.width ?? 0);
  const splitter = page.getByRole("separator", { name: "Resize event details" });
  const width = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(width + 10));
  const box = await splitter.boundingBox();
  if (!box) throw new Error("No splitter");
  await page.mouse.move(box.x + 2, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x - 42, box.y + 60);
  await page.mouse.up();
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(width + 10);
  await page.getByRole("button", { name: "Close event details", exact: true }).click();
  await expect(page.locator(".inspector-panel")).not.toBeVisible();
  await page.getByRole("button", { name: "Toggle event details" }).click();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
  await page.getByRole("button", { name: "Raw JSON", exact: true }).click();
  await expect(page.locator(".inspector-metadata")).toHaveCount(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".inspector-metadata")).toBeVisible();
  await page.locator(".inspector-panel").getByRole("button", { name: "Copy display data" }).first().click();
  expect(await page.evaluate(() => Reflect.get(window, "copiedDisplay"))).toContain("future-state");
  await page.getByRole("button", { name: `Expand event ${data.assistant}`, exact: true }).click();
  await page.getByRole("button", { name: `Expand event ${data.assistant}`, exact: true }).click();
  const resultToggle = page.getByRole("button", { name: `Expand event ${data.result}`, exact: true });
  if ((await resultToggle.getAttribute("aria-expanded")) === "true") await resultToggle.click();
  await resultToggle.click();
  await expect(
    page
      .locator(`.session-primary:not([hidden]) [data-trace-entry-id="${data.result}"] .inline-entry`)
      .getByText("Script completed", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("session-explorer-desktop.png"), animations: "disabled" });
});

test("medium/narrow and effective 150% viewport use accessible drawers without page scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1115, height: 627 });
  await explore(page);
  await expect(page.getByRole("heading", { name: "Branch view" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator(".app-grid")).toHaveClass(/narrow-layout/);
  await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Toggle event details" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("session-explorer-narrow.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("clipboard failure and long plain previews retain bounded literal rendering", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  data.manager.appendMessage({
    role: "system",
    content: Array.from({ length: 1200 }, (_, i) => `prompt line ${i}`).join("\n"),
    timestamp: 10,
  });
  await explore(page);
  await page.locator(".inspector-panel").getByRole("button", { name: "Copy display data" }).first().click();
  await expect(page.getByText("Copy failed", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "prompt", exact: true }).click();
  const preview = page
    .locator(".inspector-panel .data")
    .filter({ has: page.getByRole("button", { name: "Historical prompt · browser preview branch", exact: true }) });
  await expect(preview.locator(".code-line")).toHaveCount(1000);
  await expect(preview.locator(".preview-limit")).toBeVisible();
});

test("inline detail requests are bounded and cancelled when rows collapse", async ({ page }) => {
  let hold = false;
  let active = 0;
  let peak = 0;
  let requests = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const fourRequests = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/detail**", async (route) => {
    if (!hold) {
      await route.continue();
      return;
    }
    active++;
    requests++;
    peak = Math.max(peak, active);
    if (active === 4) ready();
    await gate;
    try {
      await route.continue();
    } catch {
      /* Request was cancelled by its unmounted inline row. */
    }
    active--;
  });
  try {
    await explore(page);
    await expect(
      page.locator(".inspector-panel").getByRole("button", { name: "Copy display data" }).first(),
    ).toBeVisible();
    hold = true;
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await fourRequests;
    expect(peak).toBe(4);
    expect(requests).toBe(4);
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    hold = false;
    release();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await nav(page, data.assistant).click();
    await expect(page.locator(".inspector-identity")).toContainText(data.assistant);
    await expect(
      page.locator(".inspector-panel").getByRole("button", { name: "Copy display data" }).first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("long labels/tab overflow and resize cancellation preserve readable panes", async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  const long = data.manager.appendCustomEntry(`thinking_level_change_${"long-name-".repeat(30)}`, { value: "test" });
  await explore(page);
  await expect(nav(page, long)).toBeVisible();
  const title = nav(page, long).locator(".row-title strong");
  expect(await title.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
  const descriptions = await page.locator(".session-primary:not([hidden]) .row-title > span").allTextContents();
  expect(descriptions.every((description) => !description.trim().startsWith("{"))).toBe(true);
  const separator = page.getByRole("separator", { name: "Resize event details" });
  await separator.focus();
  await page.keyboard.press("Home");
  const list = page.locator(".inspector-tabs > [role=tablist]");
  expect(await list.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
  await list.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.getByRole("tab", { name: "codemode", exact: true })).toBeVisible();
  const navSplitter = page.getByRole("separator", { name: "Resize event details" });
  const box = await navSplitter.boundingBox();
  if (!box) throw new Error("Missing handle");
  await page.mouse.move(box.x + 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 32, box.y + 20);
  await page.keyboard.press("Escape");
  const stopped = await navSplitter.getAttribute("aria-valuenow");
  await page.mouse.move(box.x + 62, box.y + 20);
  await page.mouse.up();
  await expect(navSplitter).toHaveAttribute("aria-valuenow", stopped ?? "");
  await page.setViewportSize({ width: 1115, height: 627 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("R7: eviction reconciles a captured selection to its remembered transcript anchor", async ({ page }) => {
  collector.start({ type: "tool_execution_start", toolCallId: "chosen", toolName: "read", args: {} }, data.assistant);
  collector.end(
    { type: "tool_execution_end", toolCallId: "chosen", toolName: "read", isError: false, result: "chosen" },
    data.assistant,
  );
  await explore(page);
  await openLive(page);
  await page.getByRole("button", { name: "read · ok", exact: true }).click();
  await expect(page.locator(".inspector-identity")).toContainText("Captured execution");
  for (let i = 0; i < 128; i++)
    collector.end(
      { type: "tool_execution_end", toolCallId: `new-${i}`, toolName: "test", isError: false, result: i },
      data.leaf,
    );
  server.invalidate(++revision);
  await expect(page.locator(".inspector-identity")).toContainText(data.assistant);
  await expect(page.locator(".inspector-identity")).not.toContainText("Captured execution");
  await expect(nav(page, data.assistant)).toHaveAttribute("aria-current", "true");
});

test("R6: repeated raw IDs remain independently selectable across live updates", async ({ page }) => {
  for (const anchor of [data.assistant, data.leaf]) {
    collector.start({ type: "tool_execution_start", toolCallId: "same", toolName: "read", args: { anchor } }, anchor);
    collector.end(
      { type: "tool_execution_end", toolCallId: "same", toolName: "read", isError: false, result: anchor },
      anchor,
    );
  }
  const records = collector.list();
  await explore(page);
  await openLive(page);
  await expect(page.getByRole("button", { name: "read · ok", exact: true })).toHaveCount(2);
  await page.locator(`[id="live-call-${records[0]?.occurrenceId}"] .call-trigger`).click();
  await expect(page.locator(".inspector-identity")).toContainText(records[0]?.occurrenceId ?? "");
  await expect(page.locator(".inspector-metadata")).toContainText(data.assistant);
  await page.locator(`[id="live-call-${records[1]?.occurrenceId}"] .call-trigger`).click();
  await expect(page.locator(".inspector-metadata")).toContainText(data.leaf);
});

test("R8: navigator reveals a new selection on the same page without resetting scroll on live refresh", async ({
  page,
}) => {
  const ids: string[] = [];
  for (let i = 0; i < 80; i++) ids.push(data.manager.appendCustomEntry(`step-${i}`, {}));
  const target = ids[25];
  if (!target) throw new Error("No target");
  await explore(page);
  await expect(row(page, data.manager.getLeafId() ?? "")).toBeVisible();
  await page
    .locator(".session-primary:not([hidden]) .trace-panel")
    .getByRole("button", { name: "Previous", exact: true })
    .click();
  await row(page, target).click();
  await expect(nav(page, target)).toHaveAttribute("aria-current", "true");
  await expect
    .poll(() =>
      page.locator(".session-primary:not([hidden]) .trace-scroll").evaluate((container) => {
        const selected = container.querySelector('[aria-current="true"]');
        if (!selected) return false;
        const a = container.getBoundingClientRect();
        const b = selected.getBoundingClientRect();
        return b.top >= a.top && b.bottom <= a.bottom;
      }),
    )
    .toBe(true);
  await page.locator(".session-primary:not([hidden]) .trace-scroll").evaluate((container) => {
    container.scrollTop = 0;
  });
  const refreshed = page.waitForResponse((response) => response.url().includes("/api/snapshot") && response.ok());
  server.invalidate(++revision);
  await refreshed;
  await expect(page.locator(".session-primary:not([hidden]) .trace-scroll")).toHaveJSProperty("scrollTop", 0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("R9: selected detail errors are explicit and retry recovers without changing selection", async ({ page }) => {
  let failed = true;
  await page.route("**/api/detail**", async (route) => {
    if (failed) await route.fulfill({ status: 400, contentType: "text/plain", body: "Unavailable session data" });
    else await route.continue();
  });
  await explore(page);
  await expect(page.locator(".inspector-panel").getByRole("alert")).toContainText("Could not load entry details");
  const selected = data.manager.getLeafId();
  failed = false;
  await page.getByRole("button", { name: "Retry selected details", exact: true }).click();
  await expect(page.locator(".inspector-panel").getByRole("alert")).toHaveCount(0);
  await expect(
    page.locator(".inspector-panel").getByRole("button", { name: "Copy display data" }).first(),
  ).toBeVisible();
  await expect(page.locator(".inspector-identity")).toContainText(selected ?? "");
});

test("R10: pagination, collapse and filters retain a visible roving trace target", async ({ page }) => {
  for (let i = 0; i < 100; i++) data.manager.appendCustomEntry(`page-${i}`, {});
  await explore(page);
  await expect(row(page, data.manager.getLeafId() ?? "")).toBeVisible();
  const trace = page.locator(".session-primary:not([hidden]) .trace-panel");
  const targets = trace.locator('[role="treeitem"][tabindex="0"]');
  await expect(targets).toHaveCount(1);
  await trace.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(targets).toHaveCount(1);
  await targets.focus();
  const before = await targets.getAttribute("data-trace-id");
  await page.keyboard.press("ArrowDown");
  await expect(targets).toHaveCount(1);
  await expect(targets).not.toHaveAttribute("data-trace-id", before ?? "");
  await expect(targets).toBeFocused();
  await trace.locator('[role="treeitem"]').last().focus();
  await page.keyboard.press("ArrowDown");
  await expect(targets).toHaveCount(1);
  await expect(targets).toBeFocused();
  await trace.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(targets).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search session" }).fill("page-60");
  await expect(targets).toHaveCount(1);
});

test("R11: transient SSE refusals retry, while authentication and generation failures are terminal", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/events?**", async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 429, body: "Too many viewers" });
    else if (attempts === 2) await route.fulfill({ status: 503, body: "Unavailable" });
    else await route.continue();
  });
  await explore(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  expect(attempts).toBe(3);
  await expect(page.locator(".session-primary:not([hidden]) .trace-panel [role=treeitem]").first()).toBeVisible();
});

test("R11: expired SSE credentials do not schedule another request", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/events?**", async (route) => {
    attempts++;
    await route.fulfill({ status: 409, body: "Changed" });
  });
  await explore(page);
  await expect(
    page.getByText("Session expired or unauthorized; open the viewer again from Pi.", { exact: true }),
  ).toBeVisible();
  const timers = await page.evaluate(() => {
    let retry = false;
    const original = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 1000) retry = true;
      return original(handler, delay, ...args);
    }) as typeof window.setTimeout;
    return new Promise<boolean>((resolve) => original(() => resolve(retry), 1100));
  });
  expect(timers).toBe(false);
  expect(attempts).toBe(1);
});

test("R11: incompatible stream generations stop without a reconnect", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/events?**", async (route) => {
    attempts++;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"protocol":1,"generation":"other","revision":0}\n\n',
    });
  });
  await explore(page);
  await expect(page.getByText("Session changed; open the viewer again from Pi.", { exact: true })).toBeVisible();
  // The scheduling window is the observable behavior; use the page's timer rather than a shell sleep.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  expect(attempts).toBe(1);
});

test("R12/R13: cyclic selection preserves raw evidence, and long session names expose truncation", async ({ page }) => {
  const a = data.manager.appendCustomEntry("cycle-a", {});
  const b = data.manager.appendCustomEntry("cycle-b", {});
  const entry = data.manager.getEntry(a);
  if (!entry) throw new Error("Missing cycle");
  entry.parentId = b;
  data.manager.branch(data.leaf);
  data.manager.appendSessionInfo("visible".repeat(1000));
  await explore(page);
  await expect(page.locator(".header-context")).toContainText("truncated");
  await page.getByRole("textbox", { name: "Search session" }).fill("cycle-a");
  await row(page, a).click();
  await expect(page.locator(".inspector-panel").getByRole("status")).toContainText("recorded parent cycle");
  await expect(page.locator(".inspector-identity")).toContainText(a);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
});

test("R14: malformed runtime identity remains bounded raw evidence without a render crash", async ({ page }) => {
  const id = data.manager.appendCustomEntry("broken", { evidence: "evidence" });
  const entry = data.manager.getEntry(id);
  if (!entry) throw new Error("Missing malformed fixture");
  (entry as unknown as Record<string, unknown>).id = 42;
  await explore(page);
  await expect(page.locator(".session-primary:not([hidden]) .trace-panel [role=treeitem]").first()).toBeVisible();
  await page.locator(".invalid-entries > summary").click();
  await expect(page.locator(".invalid-entries")).toContainText("non-string entry id");
  await expect(page.locator(".invalid-entries")).toContainText("evidence");
});

test("R15: selected branch failure survives live snapshots and retries without moving selection", async ({ page }) => {
  let failed = true;
  await page.route("**/api/branch?**", async (route) => {
    if (failed) await route.fulfill({ status: 503, body: "Temporary failure" });
    else await route.continue();
  });
  await explore(page);
  const alert = page.locator(".branch-failure");
  await expect(alert).toContainText("Could not load selected branch context.");
  const next = page.waitForResponse((response) => response.url().includes("/api/snapshot") && response.ok());
  server.invalidate(++revision);
  await next;
  await expect(alert).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Retry selected branch", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".inspector-identity")).toContainText(data.manager.getLeafId() ?? "");
  await page.getByRole("tab", { name: "prompt", exact: true }).click();
  await expect(page.locator(".inspector-panel")).toContainText("changed");
});

test("R16: JSON object disclosure is independent and retained for each selected-entry scope", async ({ page }) => {
  const a = data.manager.appendCustomEntry("json-a", { shared: { nested: { a: 1 } } });
  const b = data.manager.appendCustomEntry("json-b", { shared: { nested: { b: 2 } } });
  await explore(page);
  await nav(page, a).click();
  const shared = page.locator(".inspector-panel").getByText("shared", { exact: true }).locator("..").locator("..");
  await expect(shared).not.toHaveAttribute("open", "");
  await shared.locator(":scope > summary").click();
  await expect(shared).toHaveAttribute("open", "");
  await nav(page, b).click();
  await expect(shared).not.toHaveAttribute("open", "");
  await shared.locator(":scope > summary").click();
  await expect(shared).toHaveAttribute("open", "");
  await nav(page, a).click();
  await expect(shared).toHaveAttribute("open", "");
  await shared.locator(":scope > summary").click();
  await expect(shared).not.toHaveAttribute("open", "");
  await nav(page, b).click();
  await expect(shared).toHaveAttribute("open", "");
});

test("R17: filtered direct-child count is labeled visible rather than recorded total", async ({ page }) => {
  data.manager.branch(data.leaf);
  const parent = data.manager.appendCustomEntry("sibling-parent", {});
  data.manager.appendCustomEntry("match-child", {});
  data.manager.branch(parent);
  data.manager.appendCustomEntry("hidden-child-one", {});
  data.manager.branch(parent);
  data.manager.appendCustomEntry("hidden-child-two", {});
  await explore(page);
  await page.getByRole("textbox", { name: "Search session" }).fill("match-child");
  const disclosure = page.locator(`.session-primary:not([hidden]) [data-trace-entry-id="${parent}"] .expand-button`);
  if ((await disclosure.getAttribute("aria-expanded")) === "true") await disclosure.click();
  await disclosure.click();
  await expect(
    page.locator(`.session-primary:not([hidden]) [data-trace-entry-id="${parent}"] .children-label`),
  ).toContainText("1 visible child entry");
  await expect(
    page.locator(`.session-primary:not([hidden]) [data-trace-entry-id="${parent}"] .children-label`),
  ).not.toContainText("recorded");
});

test("R18: a failed snapshot recovers while the SSE connection stays quiet", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/snapshot?**", async (route) => {
    attempts++;
    if (attempts === 1) await route.abort("connectionreset");
    else await route.continue();
  });
  await explore(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.locator(".session-primary:not([hidden]) .trace-panel [role=treeitem]").first()).toBeVisible();
  expect(attempts).toBe(2);
});

test("R18: terminal snapshot admission does not retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/snapshot?**", async (route) => {
    attempts++;
    await route.fulfill({ status: 409, body: "Changed" });
  });
  await explore(page);
  await expect(page.getByText("Session expired; open a new viewer from Pi.", { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  expect(attempts).toBe(1);
});

test("R18: terminal SSE shutdown cancels a pending snapshot retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/snapshot?**", async (route) => {
    attempts++;
    await route.fulfill({ status: 503, body: "Transient" });
  });
  await explore(page);
  await expect(
    page.getByText("Viewer unavailable; reconnecting requires a running Pi session.", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/events?**", async (route) => route.fulfill({ status: 403, body: "Expired" }));
  await server.close();
  await expect(
    page.getByText("Session expired or unauthorized; open the viewer again from Pi.", { exact: true }),
  ).toBeVisible();
  const stopped = attempts;
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  expect(attempts).toBe(stopped);
});

test("R19/R20: malformed kind and duplicate records remain raw diagnostics, not React nodes", async ({ page }) => {
  const malformed = data.manager.appendCustomEntry("bad-kind", {});
  const entry = data.manager.getEntry(malformed);
  if (!entry) throw new Error("No malformed");
  (entry as unknown as Record<string, unknown>).type = { invalid: "kind" };
  const other = data.manager.appendCustomEntry("duplicate", {});
  const duplicate = data.manager.getEntry(other);
  if (!duplicate) throw new Error("No duplicate");
  duplicate.id = data.user;
  await explore(page);
  await expect(page.locator(".session-primary:not([hidden]) .trace-panel [role=treeitem]").first()).toBeVisible();
  await page.locator(".invalid-entries > summary").click();
  await expect(page.locator(".invalid-entries")).toContainText("entry type");
  await expect(page.locator(".invalid-entries")).toContainText("duplicate entry id");
  await expect(nav(page, data.user)).toHaveCount(0);
});

test("large history pages visible rows lazily and preserves arbitrary absolute depth", async ({ page }) => {
  for (let i = 0; i < 1500; i++)
    data.manager.appendMessage({ role: "user", content: `fixture row ${i}`, timestamp: i });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await explore(page);
  await expect(row(page, data.manager.getLeafId() ?? "")).toBeVisible();
  expect(await page.locator(".session-primary:not([hidden]) .trace-row").count()).toBeLessThanOrEqual(100);
  expect(await page.locator(".trace-item").count()).toBeLessThanOrEqual(50);
  expect(Number(await row(page, data.manager.getLeafId() ?? "").getAttribute("aria-level"))).toBeGreaterThan(1500);
  expect(requests.filter((url) => url.includes("/api/detail"))).toHaveLength(1);
});

test("R37: eviction reveals a filtered-out anchor using filter ownership at async admission", async ({ page }) => {
  const initialLeaf = data.manager.getLeafId();
  collector.start(
    { type: "tool_execution_start", toolCallId: "chosen", toolName: "unique-selection-name", args: {} },
    data.assistant,
  );
  collector.end(
    {
      type: "tool_execution_end",
      toolCallId: "chosen",
      toolName: "unique-selection-name",
      isError: false,
      result: "chosen",
    },
    data.assistant,
  );
  let hold = false;
  let release!: () => void;
  let ready!: () => void;
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/snapshot?**", async (route) => {
    const response = await route.fetch();
    if (hold) {
      ready();
      await pending;
    }
    await route.fulfill({ response });
  });
  try {
    await explore(page);
    await openLive(page);
    await page.getByRole("button", { name: "unique-selection-name · ok", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search session" });
    await search.fill("unique-selection-name");
    for (let i = 0; i < 128; i++)
      collector.end(
        { type: "tool_execution_end", toolCallId: `new-${i}`, toolName: "test", isError: false, result: i },
        data.leaf,
      );
    hold = true;
    server.invalidate(++revision);
    await admitted;
    await search.fill("UNIQUE-SELECTION-NAME");
    hold = false;
    release();
    await expect(page.locator(".inspector-identity")).toContainText(data.assistant);
    await expect(nav(page, data.assistant)).toHaveAttribute("aria-current", "true");
    await expect(row(page, data.assistant)).toBeVisible();
    await expect(search).toHaveValue("UNIQUE-SELECTION-NAME");
    expect(data.manager.getLeafId()).toBe(initialLeaf);
  } finally {
    hold = false;
    release();
  }
});

test("R43: bounded refresh reconciles an omitted entry, reveals filtered fallback and preserves represented previews", async ({
  page,
}) => {
  for (let i = 0; i < 10001; i++) {
    data.manager.branch(data.user);
    data.manager.appendCustomEntry("off", {});
  }
  data.manager.branch(data.user);
  const late = data.manager.appendCustomEntry("late-selected", {});
  await explore(page);
  await expect(row(page, late)).toBeVisible();
  await expect(page.locator(".inspector-identity")).toContainText(late);
  const search = page.getByRole("textbox", { name: "Search session" });
  await search.fill("no-record-matches-this-query");
  data.manager.branch(data.alternate);
  server.invalidate(++revision);
  await expect(page.locator(".inspector-identity")).toContainText(data.alternate);
  await expect(page.locator(".inspector-identity")).not.toContainText(late);
  await expect(nav(page, data.alternate)).toHaveAttribute("aria-current", "true");
  await expect(row(page, data.alternate)).toBeVisible();
  await expect(search).toHaveValue("no-record-matches-this-query");
  expect(data.manager.getLeafId()).toBe(data.alternate);
  data.manager.branch(data.user);
  const updated = page.waitForResponse((response) => response.url().includes("/api/snapshot") && response.ok());
  server.invalidate(++revision);
  await updated;
  await expect(page.locator(".inspector-identity")).toContainText(data.alternate);
  expect(data.manager.getLeafId()).toBe(data.user);
});

test("R43: an empty represented inventory clears prior selection and cached detail", async ({ page }) => {
  let empty = false;
  await page.route("**/api/snapshot?**", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({
      response,
      json: empty ? { ...value, nodes: [], leafId: null, calls: [], totalEntries: 0 } : value,
    });
  });
  await explore(page);
  await nav(page, data.assistant).click();
  await expect(page.locator(".inspector-identity")).toContainText(data.assistant);
  empty = true;
  server.invalidate(++revision);
  await expect(page.locator(".inspector-identity")).toContainText("no selection");
  await expect(page.locator(".inspector-identity")).not.toContainText(data.assistant);
  await expect(page.locator('.session-primary:not([hidden]) .trace-row[aria-current="true"]')).toHaveCount(0);
});

test("R45: same anchor regains reveal ownership beyond 100 navigator rows after call eviction", async ({ page }) => {
  for (let i = 0; i < 300; i++) {
    data.manager.branch(data.user);
    data.manager.appendCustomEntry(i < 150 ? "retained" : "other", {});
  }
  data.manager.branch(data.user);
  const anchor = data.manager.appendMessage(fauxAssistantMessage([]));
  collector.start(
    { type: "tool_execution_start", toolCallId: "chosen", toolName: "retained-selected-call", args: {} },
    anchor,
  );
  collector.end(
    {
      type: "tool_execution_end",
      toolCallId: "chosen",
      toolName: "retained-selected-call",
      isError: false,
      result: "chosen",
    },
    anchor,
  );
  await explore(page);
  await expect(nav(page, anchor)).toBeVisible();
  await openLive(page);
  await page.getByRole("button", { name: "retained-selected-call · ok", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search session" });
  await search.fill("retained");
  await expect(nav(page, anchor)).toHaveCount(0);
  for (let i = 0; i < 128; i++)
    collector.end(
      { type: "tool_execution_end", toolCallId: `new-${i}`, toolName: "test", isError: false, result: i },
      data.leaf,
    );
  server.invalidate(++revision);
  await expect(nav(page, anchor)).toHaveAttribute("aria-current", "true");
  await expect(nav(page, anchor)).toBeVisible();
  await expect(row(page, anchor)).toBeVisible();
  await expect(page.locator(".inspector-identity")).toContainText(anchor);
  await expect(search).toHaveValue("retained");
  await page.locator(".session-primary:not([hidden])").getByRole("button", { name: "Previous", exact: true }).click();
  await expect(nav(page, anchor)).toHaveCount(0);
  const received = page.waitForResponse((response) => response.url().includes("/api/snapshot") && response.ok());
  server.invalidate(++revision);
  await received;
  await expect(nav(page, anchor)).toHaveCount(0);
  expect(data.manager.getLeafId()).toBe(anchor);
});

test("R48: rejected live IDs are omitted with an explicit unavailable correlation summary", async ({ page }) => {
  const id = "oversized-".repeat(10000);
  collector.start({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} }, data.assistant);
  await explore(page);
  await openLive(page);
  await expect(page.getByText("1 invalid live events omitted; correlation unavailable", { exact: true })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(id);
  const response = await page.request.get(`${server.origin}/api/snapshot?generation=browser-fixture`, {
    headers: { "X-Inspector-Token": server.token },
  });
  const value = await response.json();
  expect(value.invalidCallEvents).toBe(1);
  expect(value.calls).toEqual([]);
});

test("R51: evicted parent remains explicitly recorded in live child details", async ({ page }) => {
  collector = new Collector(2);
  collector.start({ type: "tool_execution_start", toolCallId: "parent", toolName: "parent", args: {} }, data.assistant);
  collector.start(
    { type: "tool_execution_start", toolCallId: "child", parentToolCallId: "parent", toolName: "child", args: {} },
    data.assistant,
  );
  collector.end(
    { type: "tool_execution_end", toolCallId: "other", toolName: "other", isError: false, result: "done" },
    data.leaf,
  );
  await explore(page);
  await openLive(page);
  await page.getByRole("button", { name: "child · running", exact: true }).click();
  await expect(page.getByText("Parent parent (not captured)", { exact: true })).toBeVisible();
});

test("R52: a retained call's omitted bounded anchor is explicitly unavailable, not a phantom navigation target", async ({
  page,
}) => {
  for (let i = 0; i < 10001; i++) {
    data.manager.branch(data.user);
    data.manager.appendCustomEntry("off", {});
  }
  data.manager.branch(data.user);
  const anchor = data.manager.appendMessage(fauxAssistantMessage([]));
  collector.start({ type: "tool_execution_start", toolCallId: "kept", toolName: "kept-call", args: {} }, anchor);
  await explore(page);
  await openLive(page);
  await page.getByRole("button", { name: "kept-call · running", exact: true }).click();
  data.manager.branch(data.alternate);
  server.invalidate(++revision);
  await expect(
    page.getByText("Recorded anchor omitted from this bounded inventory; navigator target unavailable.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.session-primary:not([hidden]) .trace-row[aria-current="true"]')).toHaveCount(0);
  await expect(page.locator(".inspector-identity")).toContainText("Captured execution");
  expect(data.manager.getLeafId()).toBe(data.alternate);
});

test("R59: selected child stays revealable after late parent adoption, without reopening manual disclosure on passive refresh", async ({
  page,
}) => {
  collector.start(
    {
      type: "tool_execution_start",
      toolCallId: "child",
      parentToolCallId: "late-parent",
      toolName: "child-selected",
      args: {},
    },
    data.assistant,
  );
  await explore(page);
  await openLive(page);
  await page.getByRole("button", { name: "child-selected · running", exact: true }).click();
  collector.start(
    { type: "tool_execution_start", toolCallId: "late-parent", toolName: "parent", args: {} },
    data.assistant,
  );
  server.invalidate(++revision);
  await expect(page.getByRole("button", { name: "child-selected · running", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand call call-2", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.getByRole("button", { name: "Expand call call-2", exact: true }).click();
  server.invalidate(++revision);
  await expect(page.getByRole("button", { name: "Expand call call-2", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
