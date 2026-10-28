import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import type { CacheHistory, Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { cacheAssistant, cacheModel, cacheUsage } from "./cache-fixtures.js";

let manager: SessionManager;
let server: ViewerServer;
let points: CacheHistory["trend"] | undefined;

test.beforeEach(async () => {
  manager = SessionManager.inMemory("/synthetic-cache-trend");
  points = undefined;
  server = await startServer({
    generation: "cache-trend",
    signal: new AbortController().signal,
    snapshot: () => {
      const value: Snapshot = snapshot(
        manager,
        new Collector(),
        "cache-trend",
        0,
        "",
        [],
        [],
        [],
        undefined,
        undefined,
        () => cacheModel,
      );
      if (points && value.cache) value.cache.trend = points;
      return value;
    },
    branch: (id, offset) => branch(manager, id, offset, []),
    detail: (id, leaf) => detail(manager, id, leaf, new Collector()),
  });
});
test.afterEach(async () => server.close());

// Override only the trend projection to exercise exact raw decimals and old snapshot metadata.
// Real session entries keep every Event details action backed by an independently identifiable response.
function seed(rates: (number | null)[], epochs?: (number | undefined)[]) {
  points = rates.map((rate, index) => {
    const entryId = manager.appendMessage(
      cacheAssistant(rate === null ? cacheUsage(0, 0) : cacheUsage(100 - rate, rate), {
        content: [{ type: "text", text: `Synthetic response ${index + 1}` }],
        timestamp: 1000 + index,
      }),
    );
    return { entryId, hitRatePercent: rate, ...(epochs?.[index] === undefined ? {} : { epoch: epochs[index] }) };
  });
}
async function open(page: Page, width = 1280, dark = false) {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(server.url);
  await page.getByRole("tab", { name: "Cache", exact: true }).click();
  if (dark) await page.getByRole("button", { name: "Toggle appearance" }).click();
  await expect(page.locator(".inspector-app")).toHaveClass(dark ? /dark/ : /light/);
  return page.getByRole("region", { name: "Hit-rate trend", exact: true });
}
function samples(trend: Locator) {
  return trend.getByRole("list", { name: "Conversational hit-rate trend", exact: true }).locator(":scope > li");
}
async function summary(trend: Locator, latest: string, minimum: string) {
  await expect(trend.locator(".cache-trend-summary dd")).toHaveText([latest, minimum]);
}
async function axes(trend: Locator) {
  await expect(trend.locator(".cache-trend-axis span")).toHaveText(["100%", "90%", "50%", "0%"]);
  expect(
    await trend
      .locator(".cache-trend-grid span")
      .evaluateAll((lines) => lines.map((line) => (line as HTMLElement).style.bottom)),
  ).toEqual(["100%", "90%", "50%", "0%"]);
}
async function bounded(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("empty and auxiliary-only usage have no fabricated axes or samples", async ({ page }, testInfo) => {
  const trend = await open(page);
  await expect(trend).toContainText("No conversational responses yet. The trend appears after a response is recorded.");
  await expect(trend.locator(".cache-trend-chart, .cache-trend-summary, .cache-trend li")).toHaveCount(0);
  await trend.screenshot({ path: testInfo.outputPath("empty-desktop-light.png") });
  manager.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
  server.invalidate(1);
  await expect(page.locator(".cache-record")).toHaveCount(1);
  await expect(page.locator(".cache-totals")).toContainText("Weighted hit rate80%");
  await expect(trend).toContainText("No conversational responses yet.");
  await expect(trend.locator(".cache-trend-chart, .cache-trend li")).toHaveCount(0);
  await page.locator(".cache-record summary").click();
  await expect(page.locator(".cache-record")).toContainText("Auxiliary usage");
});

for (const activation of ["pointer", "Enter", "Space"] as const) {
  test(`all unknown samples retain count, unknown summaries and native ${activation} details actions without axes`, async ({
    page,
  }) => {
    seed([null, null, null]);
    const trend = await open(page, activation === "pointer" ? 390 : 1280);
    await expect(trend).toContainText("Latest 3 conversational responses, oldest first.");
    await expect(trend).toContainText("Hit rate is unavailable for the recorded responses.");
    await expect(trend).not.toContainText("No conversational responses yet");
    await summary(trend, "unavailable", "unavailable");
    await expect(trend.locator(".cache-trend-chart, .cache-trend-bar, .cache-trend-zero")).toHaveCount(0);
    const actions = trend.getByRole("list", { name: "Response hit rates", exact: true }).getByRole("button");
    await expect(actions).toHaveCount(3);
    await expect(actions.nth(1)).toHaveAccessibleName(
      "Response 2 of 3: unavailable · Unavailable. View event details.",
    );
    if (activation === "pointer") await actions.nth(1).click();
    else {
      await actions.nth(1).focus();
      await page.keyboard.press(activation);
    }
    await expect(page.locator(".inspector-panel")).toContainText("Synthetic response 2");
    if (activation === "pointer")
      await expect(page.getByRole("dialog", { name: "Event details", exact: true })).toBeVisible();
  });
}

test("unknown response action survives displacement from the 200 usage rows by auxiliary records", async ({ page }) => {
  const response = manager.appendMessage(
    cacheAssistant(cacheUsage(0, 0), {
      content: [{ type: "text", text: "Synthetic displaced unknown response" }],
    }),
  );
  for (let index = 0; index < 201; index++) {
    manager.appendUsage("cache_warm", cacheModel.provider, cacheModel.id, cacheUsage());
  }
  const leaf = manager.getLeafId();
  const trend = await open(page);
  await expect(page.locator(".cache-record")).toHaveCount(200);
  await expect(page.locator(".cache-view")).toContainText("2 older records omitted");
  await expect(trend).toContainText("Latest 1 conversational response, oldest first.");
  await summary(trend, "unavailable", "unavailable");
  await expect(trend.locator(".cache-trend-chart")).toHaveCount(0);
  await trend
    .getByRole("button", { name: "Response 1 of 1: unavailable · Unavailable. View event details.", exact: true })
    .click();
  await expect(page.locator(".inspector-panel")).toContainText("Synthetic displaced unknown response");
  expect(manager.getLeafId()).toBe(leaf);
  expect(response).not.toBe(leaf);
});

for (const rates of [[80], [0, 100], [49.999, 90, null]]) {
  test(`${rates.length} sparse samples retain exact values and fixed-capacity slots`, async ({ page }, testInfo) => {
    seed(rates);
    const trend = await open(page, rates.length === 2 ? 390 : 1280, rates.length === 2);
    const values =
      rates.length === 1
        ? ["1: 80% · Moderate"]
        : rates.length === 2
          ? ["1: 0% · Low", "2: 100% · High"]
          : ["1: 49.999% · Low", "2: 90% · High", "3: unavailable · Unavailable"];
    await expect(trend.getByRole("list", { name: "Response hit rates", exact: true }).locator("li")).toHaveText(values);
    await expect(samples(trend)).toHaveCount(rates.length);
    await summary(
      trend,
      rates.at(-1) === null ? "unavailable" : `${rates.at(-1)}%`,
      rates.length === 1 ? "80%" : rates.length === 2 ? "0%" : "<50%",
    );
    await axes(trend);
    const slots = await trend.locator(".cache-trend").evaluate((list) => {
      const children = [...list.children];
      return {
        columns: getComputedStyle(list).gridTemplateColumns.split(" ").length,
        width: list.getBoundingClientRect().width,
        sampleWidths: children.map((child) => child.getBoundingClientRect().width),
      };
    });
    expect(slots.columns).toBe(32);
    for (const width of slots.sampleWidths) expect(width).toBeCloseTo(slots.width / 32, 1);
    await bounded(page);
    await trend.screenshot({
      path: testInfo.outputPath(`${rates.length}-samples-${rates.length === 2 ? "narrow-dark" : "desktop-light"}.png`),
    });
  });
}

for (const [rate, formatted, band] of [
  [0.001, "<0.01%", "Low"],
  [49.995, "49.99%", "Low"],
  [49.999, "<50%", "Low"],
  [89.999, "<90%", "Moderate"],
  [99.999, "<100%", "High"],
] as const) {
  test(`summary rounds ${rate}% without claiming the next threshold`, async ({ page }) => {
    seed([rate]);
    const trend = await open(page);
    await summary(trend, formatted, formatted);
    await expect(trend.locator(".cache-trend-values li")).toHaveText(`1: ${rate}% · ${band}`);
    await expect(trend.locator(".cache-trend-inspection")).toContainText(`${rate}% · ${band}`);
  });
}

test("raw threshold bands, heights and exact inspection never mislabel rounded rates", async ({ page }) => {
  const rates = [0, 0.001, 49.999, 50, 50.001, 89.999, 90, 90.001, 100, null];
  const bands = ["Low", "Low", "Low", "Moderate", "Moderate", "Moderate", "High", "High", "High", "Unavailable"];
  seed(rates);
  const trend = await open(page);
  await axes(trend);
  await summary(trend, "unavailable", "0%");
  await expect(trend.locator(".cache-trend-inspection")).toContainText("Response 10 of 10: unavailable · Unavailable");
  await expect(trend.locator(".cache-trend-values")).toHaveCount(0);
  for (let index = 0; index < rates.length; index++) {
    const item = samples(trend).nth(index);
    const rate = rates[index];
    const exact = rate === null ? "unavailable" : `${rate}%`;
    await expect(item).toHaveAttribute("data-band", bands[index]);
    const button = item.getByRole("button", {
      name: `Response ${index + 1} of 10: ${exact} · ${bands[index]}. View event details.`,
      exact: true,
    });
    await expect(button).toHaveJSProperty("tagName", "BUTTON");
    if (rate === null) {
      await expect(item.locator(".cache-trend-unknown")).toHaveText("×");
      await expect(item.locator(".cache-trend-bar, .cache-trend-zero")).toHaveCount(0);
    } else if (rate === 0) {
      await expect(item.locator(".cache-trend-zero")).toBeVisible();
      await expect(item.locator(".cache-trend-bar, .cache-trend-unknown")).toHaveCount(0);
      expect(await item.locator(".cache-trend-zero").evaluate((mark) => getComputedStyle(mark).borderTopWidth)).toBe(
        "3px",
      );
    } else {
      expect(await item.locator(".cache-trend-bar").evaluate((bar) => (bar as HTMLElement).style.height)).toBe(
        `${rate}%`,
      );
    }
    await button.focus();
    await expect(trend.locator(".cache-trend-inspection")).toContainText(
      `Response ${index + 1} of 10: ${exact} · ${bands[index]}`,
    );
  }
  await samples(trend).nth(2).getByRole("button").hover();
  await expect(trend.locator(".cache-trend-inspection")).toContainText("49.999% · Low");
  await samples(trend).nth(5).getByRole("button").hover();
  await expect(trend.locator(".cache-trend-inspection")).toContainText("89.999% · Moderate");
});

for (const activation of ["pointer", "Enter", "Space"] as const) {
  test(`native ${activation} action opens the selected response Event details`, async ({ page }) => {
    seed([25, 75, 95]);
    const trend = await open(page, activation === "pointer" ? 390 : 1280);
    const index = activation === "pointer" ? 0 : activation === "Enter" ? 1 : 2;
    const button = samples(trend).nth(index).getByRole("button");
    if (activation === "pointer") await button.click();
    else {
      await button.focus();
      await page.keyboard.press(activation);
    }
    await expect(page.getByRole("heading", { name: "Event details", exact: true })).toBeVisible();
    await expect(page.locator(".inspector-panel")).toContainText(`Synthetic response ${index + 1}`);
    if (activation === "pointer")
      await expect(page.getByRole("dialog", { name: "Event details", exact: true })).toBeVisible();
    expect(manager.getLeafId()).toBe(points?.at(-1)?.entryId);
  });
}

test("epoch separators require adjacent known metadata, including unknown-rate samples", async ({ page }, testInfo) => {
  seed([10, 90, null, 0, 95, 75, 100], [8, 8, 9, undefined, 10, 11, 11]);
  const trend = await open(page, 390, true);
  const separators = trend.getByRole("separator");
  await expect(separators).toHaveCount(2);
  await expect(separators.nth(0)).toHaveAccessibleName("New prefix epoch 9 before response 3");
  await expect(separators.nth(1)).toHaveAccessibleName("New prefix epoch 11 before response 6");
  for (const separator of await separators.all()) {
    await expect(separator).toHaveAttribute("aria-orientation", "vertical");
    await expect(separator).toHaveCSS("border-left-style", "dashed");
  }
  await expect(samples(trend).first().getByRole("separator")).toHaveCount(0);
  await expect(trend).toContainText("Dashed lines mark prefix epoch changes; comparisons reset at each boundary.");
  await expect(samples(trend).nth(2)).toHaveAttribute("data-band", "Unavailable");
  await summary(trend, "100%", "0%");
  await bounded(page);
  await trend.screenshot({ path: testInfo.outputPath("mixed-unknown-epochs-narrow-dark.png") });
});

test("older trend snapshots without epoch metadata never invent boundaries", async ({ page }) => {
  seed([100, 0, 90]);
  const trend = await open(page);
  await expect(trend.getByRole("separator")).toHaveCount(0);
  await expect(samples(trend)).toHaveCount(3);
  await summary(trend, "90%", "0%");
});

test("malformed epoch metadata cannot invent a separator on either adjacent side", async ({ page }) => {
  const metadata = [0, null, 1, -1, 2, 0.5, 3, "4", 4, Number.MAX_SAFE_INTEGER + 1, 5];
  seed(metadata.map(() => 75));
  if (!points) throw Error("Missing synthetic points");
  // Simulate a legacy/external JSON snapshot, not a valid typed projection.
  points = points.map((point, index) => ({ ...point, epoch: metadata[index] as number }));
  const trend = await open(page);
  await expect(samples(trend)).toHaveCount(metadata.length);
  await expect(trend.getByRole("separator")).toHaveCount(0);
  await summary(trend, "75%", "75%");
});

for (const dark of [false, true]) {
  test(`${dark ? "dark" : "light"} bands have distinct fills, readable text and visible keyboard focus`, async ({
    page,
  }) => {
    seed([25, 75, 95, null]);
    const trend = await open(page, 1280, dark);
    await expect(trend.locator(".cache-trend-legend li")).toHaveCount(4);
    const fills = await trend
      .locator(".cache-trend-legend li")
      .evaluateAll((items) => items.map((item) => getComputedStyle(item, "::before").backgroundColor));
    expect(new Set(fills).size).toBe(4);
    expect(fills).not.toContain("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Tab");
    for (let index = 0; index < 4; index++) {
      const button = samples(trend).nth(index).getByRole("button");
      await button.focus();
      await expect(button).toBeFocused();
      const focus = await button.evaluate((element) => ({
        style: getComputedStyle(element).outlineStyle,
        width: getComputedStyle(element).outlineWidth,
        visible: element.matches(":focus-visible"),
      }));
      expect(focus).toEqual({ style: "solid", width: "2px", visible: true });
      const contrast = await trend.locator(".cache-trend-inspection").evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw Error("Canvas unavailable");
        const ancestors: Element[] = [];
        for (let parent: Element | null = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
        context.fillStyle = "white";
        context.fillRect(0, 0, 1, 1);
        for (const parent of ancestors) {
          context.fillStyle = getComputedStyle(parent).backgroundColor;
          context.fillRect(0, 0, 1, 1);
        }
        const luminance = () =>
          [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        const background = luminance();
        context.fillStyle = getComputedStyle(element).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = luminance();
        return {
          ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
          color: getComputedStyle(element).color,
          backgrounds: ancestors.map((parent) => getComputedStyle(parent).backgroundColor),
        };
      });
      expect.soft(contrast.ratio, `Band ${index}: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
    }
    // Unknown text, legend, axes, indexes and notes share the same tested neutral text role.
    const neutralText = await trend
      .locator(".cache-trend-inspection")
      .evaluate((element) => getComputedStyle(element).color);
    const mutedColors = await trend
      .locator(".cache-trend-legend li, .cache-trend-axis, .cache-trend-index, .cache-note")
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
    expect(new Set(mutedColors)).toEqual(new Set([neutralText]));
    for (let index = 0; index < 3; index++) {
      expect(
        await samples(trend)
          .nth(index)
          .locator(".cache-trend-bar")
          .evaluate((bar) => getComputedStyle(bar).backgroundColor),
      ).toBe(fills[index]);
    }
  });
}

test("32-point clipped history keeps chronological slots and scrolls inside a bounded narrow document", async ({
  page,
}, testInfo) => {
  // Use the real projection here: 35 responses must retain only the latest 32.
  const ids = Array.from({ length: 35 }, (_, index) =>
    manager.appendMessage(
      cacheAssistant(cacheUsage(100 - index, index), {
        content: [{ type: "text", text: `Synthetic clipped response ${index + 1}` }],
      }),
    ),
  );
  const trend = await open(page);
  await expect(samples(trend)).toHaveCount(32);
  await expect(samples(trend).first().getByRole("button")).toHaveAccessibleName(
    "Response 1 of 32: 3% · Low. View event details.",
  );
  await expect(samples(trend).last().getByRole("button")).toHaveAccessibleName(
    "Response 32 of 32: 34% · Low. View event details.",
  );
  await summary(trend, "34%", "3%");
  await axes(trend);
  await expect(trend.getByRole("separator")).toHaveCount(0);
  await expect(trend.locator(".cache-trend-values")).toHaveCount(0);
  const tops = await samples(trend).evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
  const wideWidth = await samples(trend)
    .first()
    .evaluate((item) => item.getBoundingClientRect().width);
  expect(wideWidth).toBeLessThanOrEqual(40);
  await trend.screenshot({ path: testInfo.outputPath("32-samples-desktop-light.png") });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await bounded(page);
  const scroll = trend.locator(".cache-trend-scroll");
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await samples(trend).last().getByRole("button").focus();
  expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(trend.locator(".cache-trend-inspection")).toContainText("Response 32 of 32: 34% · Low");
  await axes(trend);
  await trend.screenshot({ path: testInfo.outputPath("32-samples-narrow-dark.png") });
  await samples(trend).first().getByRole("button").focus();
  expect(await scroll.evaluate((element) => element.scrollLeft)).toBeLessThan(10);
  await page.keyboard.press("Enter");
  await expect(page.locator(".inspector-panel")).toContainText("Synthetic clipped response 4");
  expect(manager.getLeafId()).toBe(ids.at(-1));
});
