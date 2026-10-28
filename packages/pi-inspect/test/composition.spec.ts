import { expect, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import { captureContext } from "../src/context.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture } from "./fixtures.js";

let server: ViewerServer;
let messages: unknown[];
let observed = true;
test.beforeEach(async () => {
  messages = [
    { role: "system", content: "You are a helpful AI assistant. Follow the user's instructions.", timestamp: 1 },
    { role: "user", content: "Can you analyze the recent errors and suggest a fix?", timestamp: 2 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Review the recorded evidence first." },
        { type: "text", text: "I'll check the recent logs and analyze the issue." },
        { type: "toolCall", id: "c", name: "get_logs", arguments: { scope: { recent: true } } },
      ],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "c",
      content: [{ type: "text", text: "Returned twelve recorded log entries." }],
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The recorded error indicates a database timeout." }],
      timestamp: 5,
    },
    { role: "user", content: "How can we fix this?", timestamp: 6 },
    { role: "assistant", content: [{ type: "text", text: "Review the configured connection timeout." }], timestamp: 7 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "d", name: "apply_patch", arguments: { patch: "requested change" } }],
      timestamp: 8,
    },
    {
      role: "toolResult",
      toolCallId: "d",
      content: [{ type: "text", text: "Patch applied successfully." }],
      timestamp: 9,
    },
  ];
  observed = true;
  const f = fixture();
  server = await startServer({
    generation: "composition",
    signal: new AbortController().signal,
    snapshot: () => {
      const result = snapshot(f.manager, new Collector(), "composition", 0, "", [], [], []);
      result.context = captureContext(messages, observed ? "observed-pi-context" : "session-derived", f.leaf);
      return result;
    },
    branch: (id, offset) => branch(f.manager, id, offset, []),
    detail: (id, leaf) => detail(f.manager, id, leaf, new Collector()),
  });
});
test.afterEach(async () => server.close());

test("reference composition: light single-column, roles, inline content and explicit source", async ({ page }) => {
  await page.setViewportSize({ width: 1694, height: 960 });
  await page.goto(server.url);
  await expect(page.getByRole("heading", { name: "Context composition" })).toBeVisible();
  await expect(page.locator(".inspector-app")).toHaveClass(/light/);
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await expect(page.locator(".inspector-panel")).not.toBeVisible();
  await expect(page.locator(".segment-row")).toHaveCount(11);
  await expect(page.locator(".context-provenance")).toContainText("later hooks");
  await expect(page.locator(".composition-count")).toContainText("tokens unavailable");
  await page.locator(".context-segment[data-category=user]").first().locator(".segment-row").click();
  await expect(page.locator(".segment-details")).toContainText("Can you analyze");
  await expect(page.locator(".segment-details")).toContainText("Message details");
  const box = await page.locator(".context-scroll").boundingBox();
  expect(box?.width).toBeGreaterThan(1500);
  await page.screenshot({ path: test.info().outputPath("context-composition-reference.png"), animations: "disabled" });
});

test("independent expansions persist across filtering and secondary navigation; keyboard and minimap work", async ({
  page,
}) => {
  await page.goto(server.url);
  const users = page.locator(".context-segment[data-category=user] .segment-row");
  await users.first().click();
  await users.last().click();
  await expect(page.locator(".segment-details")).toHaveCount(2);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.locator(".segment-details")).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".segment-details")).toHaveCount(2);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(page.locator(".segment-details")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search context" }).fill("connection timeout");
  await expect(page.locator(".segment-row")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search context" }).fill("");
  await page.locator(".segment-row").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(users.first()).toBeFocused();
  await page.keyboard.press(" ");
  await expect(users.first()).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: /Jump to context position 10/ }).click();
  await expect(page.locator(".segment-row:focus")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle filters", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("tab", { name: "Branch view", exact: true }).click();
  await page.locator(".session-primary:not([hidden]) .trace-row").first().click();
  await expect(page.getByRole("tab", { name: "Session", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(users.last()).toHaveAttribute("aria-expanded", "true");
});

test("variable-height virtualization bounds long contexts and preserves older scroll on append", async ({ page }) => {
  messages = Array.from({ length: 2000 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i} ${"recorded text ".repeat(10)}`,
  }));
  await page.goto(server.url);
  await expect(page.locator(".composition-count")).toContainText("2000");
  expect(await page.locator(".segment-row").count()).toBeLessThan(50);
  await page.locator(".context-scroll").evaluate((node) => {
    node.scrollTop = 18000;
  });
  await expect
    .poll(async () => page.locator(".segment-row").first().getAttribute("aria-label"))
    .not.toContain("1 User");
  const top = await page.locator(".context-scroll").evaluate((node) => node.scrollTop);
  const id = await page.locator(".context-segment").nth(6).getAttribute("data-segment-id");
  if (!id) throw new Error("No row");
  await page.locator(`[data-segment-id="${id}"] .segment-row`).click();
  await expect(page.locator(`[data-segment-id="${id}"] .segment-details`)).toBeVisible();
  messages.push({ role: "user", content: "new tail event" });
  server.invalidate(2);
  await expect(page.locator(".composition-count")).toContainText("2001");
  expect(Math.abs((await page.locator(".context-scroll").evaluate((node) => node.scrollTop)) - top)).toBeLessThan(5);
  expect(await page.locator(".segment-row").count()).toBeLessThan(50);
  await page.locator(".segment-row:visible").first().focus();
  await page.keyboard.press("End");
  await expect(page.locator(".segment-row:focus")).toHaveAttribute("aria-label", /2001 User/);
  await page.keyboard.press("Home");
  await expect(page.locator(".segment-row:focus")).toHaveAttribute("aria-label", /1 User/);
});

test("dark/mobile remain readable without page scrolling or horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.url);
  await page.locator(".segment-row").first().click();
  await expect(page.locator(".segment-details")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
  await page.screenshot({
    path: test.info().outputPath("context-composition-mobile-dark.png"),
    animations: "disabled",
  });
});

test("session-derived fallback is explicit and nested raw data remains safely explorable", async ({ page }) => {
  observed = false;
  messages[1] = {
    role: "user",
    content: "<script>alert('not executable')</script>",
    metadata: { nested: { answer: 42 } },
  };
  await page.goto(server.url);
  await expect(page.locator(".context-provenance")).toContainText("Session-derived");
  await page.locator(".context-segment[data-category=user]").first().locator(".segment-row").click();
  await page.getByRole("button", { name: "Raw JSON · captured message", exact: true }).click();
  await expect(page.locator(".segment-details")).toContainText("nested");
  const rawTree = page
    .locator(".segment-details .data")
    .filter({ has: page.getByRole("button", { name: "Raw JSON · captured message", exact: true }) });
  await rawTree.getByText("metadata", { exact: true }).locator("..").click();
  const nested = rawTree.getByText("nested", { exact: true }).locator("..");
  await nested.click();
  await expect(rawTree.getByText("42", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll(".segment-details script").length)).toBe(0);
});
