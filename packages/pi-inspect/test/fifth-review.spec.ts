import { expect, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import { captureContext } from "../src/context.js";
import { capture } from "../src/privacy.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture } from "./fixtures.js";

let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let messages: unknown[];
let payload: unknown;
test.beforeEach(async () => {
  f = fixture();
  messages = Array.from({ length: 2000 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i} unique-marker-${i}`,
  }));
  payload = undefined;
  server = await startServer({
    generation: "fifth",
    signal: new AbortController().signal,
    snapshot: () => {
      const s = snapshot(f.manager, new Collector(), "fifth", 0, "", [], [], []);
      s.context = captureContext(messages, "observed-pi-context", f.leaf);
      if (payload) s.providerObservation = { observedAt: Date.now(), data: capture(payload) };
      return s;
    },
    branch: (id, offset) => branch(f.manager, id, offset, []),
    detail: (id, leaf) => detail(f.manager, id, leaf, new Collector()),
  });
});
test.afterEach(async () => server.close());
test("R33: opening widened panes cannot switch to closed drawers; desktop can collapse again", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("button", { name: "Toggle event details", exact: true }).click();
  const handle = page.getByRole("separator", { name: "Resize event details" });
  await handle.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await expect(page.locator(".app-grid")).not.toHaveClass(/narrow-layout/);
  await page.getByRole("button", { name: "Close event details", exact: true }).click();
  await expect(page.locator(".inspector-panel")).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("R28/R34: clearing distant search and categories resets source top; long paste is bounded before filtering", async ({
  page,
}) => {
  await page.goto(server.url);
  const search = page.getByRole("textbox", { name: "Search context" });
  await search.fill("unique-marker-1900");
  await expect(page.locator(".segment-row")).toHaveCount(1);
  await search.fill("");
  await expect.poll(() => page.locator(".context-scroll").evaluate((e) => e.scrollTop)).toBe(0);
  await expect(page.locator(".segment-row").first()).toHaveAttribute("aria-label", /^1 User/);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.locator(".segment-row").first()).toHaveAttribute("aria-label", /^2 Assistant/);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect.poll(() => page.locator(".context-scroll").evaluate((e) => e.scrollTop)).toBe(0);
  await search.fill("MESSAGE 19");
  await search.fill("message 19");
  await expect.poll(() => page.locator(".context-scroll").evaluate((e) => e.scrollTop)).toBe(0);
  await page.locator(".context-scroll").evaluate((e) => {
    e.scrollTop = 200;
  });
  const top = await page.locator(".context-scroll").evaluate((e) => e.scrollTop);
  messages.push({ role: "user", content: "message 19 new tail" });
  server.invalidate(2);
  await expect(page.locator(".composition-count")).toContainText("2001");
  await expect.poll(() => page.locator(".context-scroll").evaluate((e) => e.scrollTop)).toBe(top);
  await search.fill("A".repeat(100000));
  await expect(search).toHaveValue("A".repeat(512));
  await search.fill("");
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  const sessionSearch = page.getByRole("textbox", { name: "Search session" });
  await sessionSearch.fill("B".repeat(100000));
  await expect(sessionSearch).toHaveValue("B".repeat(512));
});
test("R27: a leaf beyond the snapshot cutoff is revealable and remains read-only", async ({ page }) => {
  for (let i = 0; i < 10001; i++) {
    f.manager.branch(f.user);
    f.manager.appendCustomEntry("off", {});
  }
  f.manager.branch(f.user);
  const leaf = f.manager.appendCustomEntry("late-active-leaf", {});
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("tab", { name: "Branch view", exact: true }).click();
  await expect(page.locator(`.session-primary:not([hidden]) [data-trace-id="${leaf}"]`)).toBeVisible();
  expect(f.manager.getLeafId()).toBe(leaf);
});
test("R35: replay payloads have independent time and explicit unavailable turn association", async ({ page }) => {
  payload = { maxTokens: 100 };
  await page.goto(server.url);
  await page.locator(".provider-observation > summary").click();
  await expect(page.locator(".provider-observation")).toContainText("request association unavailable");
  await expect(page.locator(".provider-observation")).toContainText("not attributed to the context leaf/turn");
  const id = await page.locator(".context-segment").first().getAttribute("data-segment-id");
  payload = { maxTokens: 1 };
  server.invalidate(2);
  await expect(page.locator(".provider-observation .json-number")).toHaveText("1");
  expect(await page.locator(".context-segment").first().getAttribute("data-segment-id")).toBe(id);
});
