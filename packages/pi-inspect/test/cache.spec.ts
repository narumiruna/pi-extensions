import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import type { Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { cacheAssistant, cacheModel, cacheUsage } from "./cache-fixtures.js";

let server: ViewerServer;
let manager: SessionManager;
let revision: number;
let transform: (value: Snapshot) => Snapshot;
test.beforeEach(async () => {
  revision = 0;
  transform = (value) => value;
  manager = SessionManager.inMemory("/cache-browser");
  manager.appendMessage(cacheAssistant(cacheUsage(1000, 0)));
  manager.appendMessage(cacheAssistant());
  manager.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
  manager.appendMessage(cacheAssistant(cacheUsage(400, 600), { timestamp: 3000 }));
  server = await startServer({
    generation: "cache-browser",
    signal: new AbortController().signal,
    snapshot: () =>
      transform(
        snapshot(
          manager,
          new Collector(),
          "cache-browser",
          revision,
          "",
          [],
          [],
          [],
          undefined,
          undefined,
          () => cacheModel,
        ),
      ),
    branch: (id, offset) => branch(manager, id, offset, []),
    detail: (id, leaf) => detail(manager, id, leaf, new Collector()),
  });
});
test.afterEach(async () => server.close());

test("cache totals, trends, comparisons and auxiliary event details are branch scoped", async ({ page }) => {
  const leaf = manager.getLeafId();
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  const cache = page.getByRole("region", { name: "Cache usage", exact: true });
  await expect(cache).toContainText(`Active branch leaf: ${leaf}`);
  await expect(cache.getByRole("list", { name: "Conversational hit-rate trend" }).locator("li")).toHaveCount(3);
  await expect(cache.locator(".cache-totals")).toContainText("Weighted hit rateunavailable");
  await cache.locator(".cache-record summary").last().click();
  await expect(cache.locator(".cache-record").last()).toContainText("-20 pp");
  await expect(cache.locator(".cache-record").last()).toContainText("400");
  await cache.locator(".cache-record summary").nth(2).click();
  await expect(cache.locator(".cache-record").nth(2)).toContainText("Auxiliary usage");
  await cache.locator(".cache-record").nth(2).getByRole("button", { name: "View event details" }).click();
  await expect(page.getByRole("heading", { name: "Event details", exact: true })).toBeVisible();
  await expect(page.locator(".inspector-panel")).toContainText("usage");
  expect(manager.getLeafId()).toBe(leaf);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  await expect(cache.locator(".cache-record").nth(2)).toHaveAttribute("open", "");
});

test("keyboard navigation, theme and narrow layout retain literal untrusted labels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  manager.appendMessage(
    cacheAssistant(undefined, {
      provider: '<img src=x onerror="window.cacheInjection=1">\u001b[31m',
      model: "Bearer private-token",
    }),
  );
  const leaf = manager.getLeafId();
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Session", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Cache", exact: true })).toBeFocused();
  const cache = page.locator(".cache-view");
  await expect(cache).toContainText("<img src=x");
  await expect(cache).toContainText("Bearer [redacted]");
  await expect(cache.locator("img, script")).toHaveCount(0);
  const summary = cache.locator("summary").last();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(cache.locator(".cache-record").last()).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await cache.locator(".cache-record").last().getByRole("button", { name: "View event details" }).click();
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible();
  expect(manager.getLeafId()).toBe(leaf);
});

test("empty, incomplete, clipped and older-protocol cache states are explicit", async ({ page }) => {
  manager = SessionManager.inMemory("/empty");
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  await expect(page.locator(".cache-view")).toContainText("No recorded usage on this branch");
  for (let i = 0; i < 205; i++) manager.appendMessage(cacheAssistant());
  server.invalidate(++revision);
  await expect(page.locator(".cache-record")).toHaveCount(200);
  await expect(page.locator(".cache-view")).toContainText("5 older records omitted");
  transform = (value) => ({
    ...value,
    cache: value.cache
      ? { ...value.cache, complete: false, unavailable: "missing recorded parent", records: [] }
      : undefined,
  });
  server.invalidate(++revision);
  await expect(page.locator(".cache-view")).toContainText("Cache data is incomplete");
  await expect(page.locator(".cache-view")).toContainText("missing recorded parent");
  await expect(page.locator(".cache-record")).toHaveCount(0);
  transform = (value) => ({ ...value, cache: undefined });
  server.invalidate(++revision);
  await expect(page.locator(".cache-view")).toContainText("Cache history unavailable in this snapshot");
});

test("branch refresh replaces cache rows without combining abandoned usage", async ({ page }) => {
  const root = manager.getLeafId();
  if (!root) throw Error("missing root");
  manager.appendMessage(cacheAssistant(cacheUsage(1, 999)));
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  await expect(page.locator(".cache-record")).toHaveCount(5);
  manager.branch(root);
  const other = manager.appendMessage(cacheAssistant(cacheUsage(999, 1)));
  server.invalidate(++revision);
  await expect(page.locator(".cache-view")).toContainText(`Active branch leaf: ${other}`);
  await expect(page.locator(".cache-record summary").last()).toContainText("0.1%");
  await expect(page.locator(".cache-record")).toHaveCount(5);
});

test("a replaced snapshot aborts its pending request and cannot restore stale branch cache", async ({ page }) => {
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  await expect(page.locator(".cache-record")).toHaveCount(4);
  let ready: () => void = () => {};
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/snapshot?*", async (route) => {
    if (!first) return route.continue();
    first = false;
    const stale = snapshot(manager, new Collector(), "cache-browser", revision, "", [], [], []);
    ready();
    await released;
    await route.fulfill({ json: stale }).catch(() => {});
  });
  const cancelled = page.waitForEvent("requestfailed", (request) => request.url().includes("/api/snapshot"));
  server.invalidate(++revision);
  await pending;
  manager.resetLeaf();
  const leaf = manager.appendMessage(cacheAssistant(cacheUsage(0, 1000)));
  server.invalidate(++revision);
  await cancelled;
  release();
  await expect(page.locator(".cache-view")).toContainText(`Active branch leaf: ${leaf}`);
  await expect(page.locator(".cache-record")).toHaveCount(1);
  await expect(page.locator(".cache-totals")).toContainText("100%");
});

test("cache API uses the existing token and generation authorization", async ({ request }) => {
  expect((await request.get(`${server.origin}/api/snapshot`)).status()).toBe(401);
  expect(
    (
      await request.get(`${server.origin}/api/snapshot?generation=other`, {
        headers: { "x-inspector-token": server.token },
      })
    ).status(),
  ).toBe(409);
  const response = await request.get(`${server.origin}/api/snapshot?generation=cache-browser`, {
    headers: { "x-inspector-token": server.token },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).cache.totals.count).toBe(4);
});
