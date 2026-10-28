import { expect, type Page, test } from "@playwright/test";
import { Type } from "typebox";
import { Collector } from "../src/collector.js";
import { captureContext } from "../src/context.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let collector: Collector;
let inventoryTools = tools;
test.beforeEach(async () => {
  f = fixture();
  collector = new Collector();
  inventoryTools = tools;
  server = await startServer({
    generation: "reading-flow",
    signal: new AbortController().signal,
    snapshot: () => ({
      ...snapshot(f.manager, collector, "reading-flow", 0, "Current runtime prompt", inventoryTools, ["read"], skills),
      context: captureContext([{ role: "user", content: "Observed input only" }], "observed-pi-context", f.leaf),
      providerObservation: { observedAt: 1, data: { value: { request: "independent payload" }, truncated: false } },
    }),
    branch: (leaf, offset) => branch(f.manager, leaf, offset, skills),
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
});
test.afterEach(async () => server.close());
const primary = (page: Page) => page.locator(".session-primary:not([hidden])");
const metadata = (page: Page, label: string) =>
  page
    .locator(".inspector-panel dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
async function session(page: Page) {
  await page.goto(server.url);
  await expect(page.locator(".segment-row").first()).toBeVisible();
  await page.getByRole("tab", { name: "Session", exact: true }).click();
}

test("Context is independent and keeps its reading state while Session is content-first", async ({ page }) => {
  let details = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/detail") || r.url().includes("/api/branch")) details++;
  });
  await page.goto(server.url);
  await page.locator(".segment-row").first().click();
  await page.getByRole("textbox", { name: "Search context" }).fill("Observed");
  await expect(page.getByRole("button", { name: "Toggle filters" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Toggle event details" })).toHaveCount(0);
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
  await expect(page.locator(".live-drawer")).not.toBeVisible();
  expect(details).toBe(0);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  const row = primary(page).locator(`[data-trace-id="${f.user}"]`);
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("tab", { name: "content", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".recorded-content")).toContainText("first request <script>alert(1)</script>");
  await expect(primary(page).locator(".inline-entry")).toHaveCount(0);
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search context" })).toHaveValue("Observed");
  await expect(page.locator(".segment-details")).toHaveCount(1);
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
});

test("non-text session messages and model changes show their recorded payload before metadata", async ({ page }) => {
  const id = f.manager.appendModelChange("faux", "new-model");
  await session(page);
  await primary(page).locator(`[data-trace-id="${id}"]`).click();
  const content = page.locator(".recorded-content");
  await expect(content).toContainText("new-model");
  await expect(content).toContainText("faux");
});

test("Session filters preserve simultaneous event groups without duplicate navigation", async ({ page }) => {
  await session(page);
  await page.locator(".filter-panel > summary").click();
  await page.getByRole("checkbox", { name: "Model events", exact: true }).check();
  await page.getByRole("checkbox", { name: "Tool events", exact: true }).check();
  await expect(primary(page).locator(`[data-trace-id="${f.assistant}"]`)).toBeVisible();
  await expect(primary(page).locator(`[data-trace-id="${f.result}"]`)).toBeVisible();
  await page.getByRole("checkbox", { name: "Model events", exact: true }).uncheck();
  await expect(primary(page).locator(`[data-trace-id="${f.assistant}"]`)).toHaveCount(0);
  await expect(primary(page).locator(`[data-trace-id="${f.result}"]`)).toBeVisible();
  await expect(page.locator(".session-filters [role=tree]")).toHaveCount(0);
});

test("History search is direct, generic internal events are opt-in, branch history is explicit and read-only", async ({
  page,
}) => {
  const leaf = f.manager.getLeafId();
  await session(page);
  await expect(primary(page).locator(`[data-trace-id="${leaf}"]`)).toHaveCount(0);
  await expect(page.getByText(/matching internal events hidden/)).toContainText("2 matching");
  await page.getByRole("checkbox", { name: "Show internal events" }).check();
  await expect(primary(page).locator(`[data-trace-id="${leaf}"]`)).toBeVisible();
  await page.getByRole("checkbox", { name: "Show internal events" }).uncheck();
  await page.getByRole("textbox", { name: "Search session" }).fill("first request");
  await expect(primary(page).locator(".trace-row")).toHaveCount(1);
  await expect(primary(page).locator(".trace-row")).toContainText("first request");
  await expect(primary(page).getByText("ancestor", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search session" }).fill("");
  await page.getByRole("tab", { name: "Branch view", exact: true }).click();
  await primary(page).locator(`[data-trace-id="${f.alternate}"]`).click();
  await page.getByRole("button", { name: "History at selected entry", exact: true }).click();
  await expect(page.getByText(`Branch leaf: ${f.alternate}`, { exact: true })).toBeVisible();
  await expect(primary(page).locator(`[data-trace-id="${f.alternate}"]`)).toBeVisible();
  await expect(primary(page).locator(`[data-trace-id="${f.result}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Follow active branch", exact: true }).click();
  await expect(primary(page).locator(`[data-trace-id="${f.result}"]`)).toBeVisible();
  await expect(primary(page).getByText("recorded parent cycle", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Selected entry is outside this branch; use Branch view to locate it.", { exact: true }),
  ).toBeVisible();
  expect(f.manager.getLeafId()).toBe(leaf);
  await page.screenshot({ path: test.info().outputPath("history-reading-flow.png"), animations: "disabled" });
});

test("branch preview shares composition without unrelated current information or provider payload", async ({
  page,
}) => {
  const leaf = f.manager.getLeafId();
  await session(page);
  await primary(page).locator(`[data-trace-id="${f.user}"]`).click();
  await page.getByRole("tab", { name: "context", exact: true }).click();
  await page.getByRole("button", { name: "View branch context", exact: true }).click();
  await expect(page.locator(".preview-context")).toContainText(`leaf ${f.user}`);
  await expect(page.locator(".preview-context .context-provenance")).toContainText("not a captured historical request");
  await expect(page.locator(".preview-context .segment-row").last()).toContainText("first request");
  await expect(page.locator(".provider-observation")).not.toBeVisible();
  await expect(page.locator(".context-inventory")).not.toBeVisible();
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to last observed context", exact: true }).click();
  await expect(page.locator(".observed-context .segment-row").first()).toContainText("Observed input only");
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.getByText("mcp__docs__search", { exact: true })).toBeVisible();
  expect(f.manager.getLeafId()).toBe(leaf);
});

test("late branch responses never become preview evidence for a newer selection", async ({ page }) => {
  let ready: () => void = () => {};
  let release: () => void = () => {};
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/branch?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("leaf") === f.result) {
      ready();
      await gate;
    }
    await route.continue().catch(() => {});
  });
  try {
    await session(page);
    await primary(page).locator(`[data-trace-id="${f.result}"]`).click();
    await admitted;
    await primary(page).locator(`[data-trace-id="${f.user}"]`).click();
    await page.getByRole("tab", { name: "context", exact: true }).click();
    await expect(page.getByRole("button", { name: "View branch context", exact: true })).toBeEnabled();
    release();
    await page.getByRole("button", { name: "View branch context", exact: true }).click();
    await expect(page.locator(".preview-context")).toContainText(`leaf ${f.user}`);
    await expect(page.locator(".preview-context")).not.toContainText("Script completed");
  } finally {
    release();
  }
});

test("Context exit aborts owned entry requests and cannot reopen stale Details", async ({ page }) => {
  let ready: () => void = () => {};
  let release: () => void = () => {};
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted = page.waitForEvent("requestfailed", { predicate: (r) => r.url().includes("/api/detail") });
  await page.route("**/api/detail?**", async (route) => {
    ready();
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await session(page);
    await primary(page).locator(`[data-trace-id="${f.user}"]`).click();
    await admitted;
    await page.getByRole("tab", { name: "Context", exact: true }).click();
    release();
    await aborted;
    await expect(page.locator(".inspector-panel")).toHaveCount(0);
    await expect(page.locator(".observed-context .segment-row").first()).toContainText("Observed input only");
  } finally {
    release();
  }
});

test("execution details have one owner and preserve real parent navigation independently of transcript ancestry", async ({
  page,
}) => {
  let historicalRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/detail") || request.url().includes("/api/branch")) historicalRequests++;
  });
  collector.start({ type: "tool_execution_start", toolCallId: "parent", toolName: "outer", args: {} }, f.assistant);
  collector.start(
    {
      type: "tool_execution_start",
      toolCallId: "child",
      parentToolCallId: "parent",
      toolName: "inner",
      args: { path: "/example" },
    },
    f.assistant,
  );
  collector.end(
    {
      type: "tool_execution_end",
      toolCallId: "child",
      parentToolCallId: "parent",
      toolName: "inner",
      isError: false,
      result: "child result",
    },
    f.assistant,
  );
  await session(page);
  await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
  await page.getByRole("button", { name: "Expand calls", exact: true }).click();
  await page.getByRole("button", { name: "inner · ok", exact: true }).click();
  await expect(page.locator(".inspector-panel")).toContainText("child result");
  await expect(page.locator(".live-drawer")).not.toContainText("child result");
  await expect(page.getByRole("tab", { name: "context", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Related execution · outer · call-1", exact: true }).click();
  await expect(page.locator(".inspector-identity")).toContainText("call-1");
  expect(historicalRequests).toBe(0);
  await page.getByRole("button", { name: "Inspect recorded anchor →", exact: true }).click();
  await expect(page.locator(".inspector-identity")).toContainText(f.assistant);
  await expect(page.getByRole("tab", { name: "Branch view", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const query of ["", "future-state"]) {
  test(`review round 2: hidden counts exclude a retained internal match (${query || "all"})`, async ({ page }) => {
    const selected = f.manager.getLeafId();
    if (!selected) throw Error("Missing fixture leaf");
    await session(page);
    await page.getByRole("textbox", { name: "Search session" }).fill(query);
    await page.getByRole("checkbox", { name: "Show internal events" }).check();
    await primary(page).locator(`[data-trace-id="${selected}"]`).click();
    await page.getByRole("checkbox", { name: "Show internal events" }).uncheck();
    await expect(primary(page).locator(`[data-trace-id="${selected}"]`)).toBeVisible();
    await expect(page.getByText(/matching internal events hidden/)).toHaveText(
      `${query ? 0 : 1} matching internal events hidden`,
    );
    await page.getByRole("textbox", { name: "Search session" }).fill("no-matches");
    await expect(primary(page).locator(`[data-trace-id="${selected}"]`)).toHaveCount(0);
    await expect(page.getByText(/matching internal events hidden/)).toHaveText("0 matching internal events hidden");
    await page.getByRole("textbox", { name: "Search session" }).fill("");
    await expect(page.getByText(/matching internal events hidden/)).toHaveText("2 matching internal events hidden");
  });
}

for (const presentation of ["List", "Timeline"] as const) {
  test(`review round 2: explicit branch History reveals its selected leaf in ${presentation}`, async ({ page }) => {
    const active = f.manager.getLeafId();
    if (!active) throw Error("Missing active fixture leaf");
    f.manager.branch(f.alternate);
    for (let i = 0; i < 60; i++) f.manager.appendMessage({ role: "user", content: `scope-row-${i}`, timestamp: i });
    const target = f.manager.getLeafId();
    if (!target) throw Error("Missing target fixture leaf");
    f.manager.branch(active);
    await session(page);
    await page.getByRole("tab", { name: "Branch view", exact: true }).click();
    await primary(page).getByRole("button", { name: "Expand all", exact: true }).click();
    await primary(page).getByRole("button", { name: "Next", exact: true }).click();
    await primary(page).getByRole("button", { name: presentation, exact: true }).click();
    await primary(page).locator(`[data-trace-id="${target}"]`).click();
    await page.getByRole("button", { name: "History at selected entry", exact: true }).click();
    await expect(primary(page).getByRole("button", { name: presentation, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const selected = primary(page).locator(`[data-trace-id="${target}"]`);
    await expect(selected).toBeVisible();
    await expect(selected).toHaveAttribute("tabindex", "0");
    await expect
      .poll(() =>
        primary(page)
          .locator(".trace-scroll")
          .evaluate((container) => {
            const row = container.querySelector('[aria-current="true"]');
            if (!row) return false;
            const bounds = container.getBoundingClientRect();
            const selected = row.getBoundingClientRect();
            return selected.top >= bounds.top - 1 && selected.bottom <= bounds.bottom + 1;
          }),
      )
      .toBe(true);
    expect(f.manager.getLeafId()).toBe(active);
    await primary(page).getByRole("button", { name: "Previous", exact: true }).click();
    await primary(page)
      .locator(".trace-scroll")
      .evaluate((container) => {
        container.scrollTop = 0;
      });
    f.manager.appendMessage({ role: "user", content: "live append on another branch", timestamp: 100 });
    server.invalidate(1);
    await expect(page.locator(".overview-metrics .metric").first().locator("strong")).toHaveText(
      String(f.manager.getEntries().length),
    );
    await expect(selected).toHaveCount(0);
    await expect(primary(page).locator(".trace-scroll")).toHaveJSProperty("scrollTop", 0);
    await expect(page.getByText(`Branch leaf: ${target}`, { exact: true })).toBeVisible();
  });
}

test("resource tabs mount catalogs on first visit and schemas only on disclosure", async ({ page }) => {
  const template = tools[0];
  if (!template) throw Error("Missing tool fixture");
  inventoryTools = Array.from({ length: 256 }, (_, i) => ({
    ...template,
    name: `inventory-tool-${i}`,
    parameters: Type.Object(
      Object.fromEntries(Array.from({ length: 64 }, (_, field) => [`field_${field}`, Type.String()])),
    ),
  }));
  await page.goto(server.url);
  await expect(page.locator(".segment-row").first()).toBeVisible();
  await expect(page.locator(".inventory-card, .tool-inventory-table, .tool-detail-content")).toHaveCount(0);
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  const inventory = page.locator("#resource-panel-tools");
  await expect(inventory.locator("tbody tr")).toHaveCount(256);
  await expect(inventory.locator(".json-tree")).toHaveCount(0);
  await inventory.getByRole("button", { name: "Inspect inventory-tool-0", exact: true }).click();
  const details = inventory.getByRole("complementary", { name: "Tool details", exact: true });
  const schema = details.locator(".data").last();
  await expect(schema.getByRole("button", { name: "Copy display data" })).toBeEnabled();
  const toggle = schema.getByRole("button", { name: "Schema · inventory-tool-0", exact: true });
  await toggle.click();
  await expect(inventory.locator(".json-tree")).toHaveCount(1);
  const properties = schema.locator("summary").filter({ hasText: /^properties / });
  await properties.click();
  await expect(properties.locator("..")).toHaveJSProperty("open", true);
  await toggle.click();
  await expect(inventory.locator(".json-tree")).toHaveCount(0);
  await toggle.click();
  await expect(properties.locator("..")).toHaveJSProperty("open", true);
  const table = inventory.getByRole("region", { name: "Scrollable tools table" });
  await table.evaluate((element) => {
    element.scrollTop = 200;
  });
  const top = await table.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.locator("#resource-panel-skills .inventory-card")).toHaveCount(1);
  await expect(inventory).not.toBeVisible();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(table).toHaveJSProperty("scrollTop", top);

  inventoryTools = inventoryTools.map((tool) => ({ ...tool, description: "Updated inventory" }));

  server.invalidate(1);
  await expect(details).toContainText("Updated inventory");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

for (const action of ["select", "evict"] as const) {
  for (const presentation of ["List", "Timeline"] as const) {
    test(`review: History ${presentation} stays active on call-to-entry ${action}`, async ({ page }) => {
      const leaf = f.manager.getLeafId();
      collector.start(
        { type: "tool_execution_start", toolCallId: "review-call", toolName: "review-call", args: {} },
        f.assistant,
      );
      await session(page);
      await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
      await page.getByRole("button", { name: "review-call · running", exact: true }).click();
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await primary(page).getByRole("button", { name: presentation, exact: true }).click();
      if (action === "select") {
        await primary(page).locator(`[data-trace-id="${f.user}"]`).click();
        await expect(page.locator(".recorded-content")).toContainText("first request");
      } else {
        collector = new Collector();
        server.invalidate(1);
        await expect(page.locator(".inspector-identity")).toContainText(f.assistant);
      }
      await expect(page.getByRole("tab", { name: "History", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(primary(page).getByRole("button", { name: presentation, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(f.manager.getLeafId()).toBe(leaf);
    });
  }
}

for (const relationship of ["root", "resolved", "missing", "invalid", "overlapping", "evicted"] as const) {
  test(`review: execution parent provenance distinguishes ${relationship}`, async ({ page }) => {
    if (relationship === "evicted") collector = new Collector(1);
    const parent = {
      type: "tool_execution_start",
      toolCallId: "review-parent",
      toolName: "review-parent",
      args: {},
    } as const;
    if (["resolved", "overlapping", "evicted"].includes(relationship)) collector.start(parent, f.assistant);
    if (relationship === "overlapping") collector.start(parent, f.assistant);
    const child = {
      type: "tool_execution_start",
      toolCallId: "review-child",
      toolName: "review-child",
      args: {},
    } as const;
    if (relationship !== "root")
      Object.assign(child, { parentToolCallId: relationship === "invalid" ? 7 : "review-parent" });
    collector.start(child, f.assistant);
    await session(page);
    await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
    await page.getByRole("button", { name: "Expand calls", exact: true }).click();
    await page.getByRole("button", { name: "review-child · running", exact: true }).click();
    const expected = {
      root: "none (root)",
      resolved: "call-1",
      missing: "unavailable",
      invalid: "Invalid or over-budget parent ID; relationship unavailable",
      overlapping: "Overlapping running parent IDs; relationship unavailable",
      evicted: "call-1",
    }[relationship];
    await expect(metadata(page, "Parent relationship")).toHaveText(expected);
    if (relationship === "evicted")
      await expect(page.getByText("Parent review-parent (not captured)", { exact: true })).toBeVisible();
  });
}

for (const anchor of ["missing", "invalid", "reused", "unrepresented", "inherited"] as const) {
  test(`review: execution correlation reflects ${anchor} anchor evidence`, async ({ page }) => {
    const event = {
      type: "tool_execution_start",
      toolCallId: "review-anchor",
      toolName: "review-anchor",
      args: {},
    } as const;
    if (anchor === "inherited") {
      collector.start({ ...event, toolCallId: "review-parent", toolName: "review-parent" }, f.assistant);
      Object.assign(event, { parentToolCallId: "review-parent" });
    }
    if (anchor === "reused") {
      collector.start(event, f.assistant);
      collector.end(
        {
          type: "tool_execution_end",
          toolCallId: "review-anchor",
          toolName: "review-anchor",
          isError: false,
          result: "done",
        },
        f.assistant,
      );
    }
    collector.start(
      event,
      anchor === "missing" || anchor === "inherited"
        ? null
        : anchor === "invalid"
          ? ""
          : anchor === "unrepresented"
            ? "outside-index"
            : f.assistant,
    );
    await session(page);
    await page.getByRole("tab", { name: /^Captured executions ·/ }).click();
    await page.getByRole("button", { name: "Expand calls", exact: true }).click();
    await page.getByRole("button", { name: "review-anchor · running", exact: true }).click();
    await expect(metadata(page, "Correlation")).toHaveText(
      ["missing", "invalid", "reused"].includes(anchor)
        ? "unavailable"
        : "Recorded anchor only; not request association",
    );
    await expect(metadata(page, "Anchor entry")).toHaveText(
      anchor === "missing" || anchor === "invalid"
        ? "unavailable"
        : anchor === "unrepresented"
          ? "outside-index"
          : f.assistant,
    );
    if (["missing", "invalid", "unrepresented"].includes(anchor))
      await expect(page.getByRole("button", { name: "Inspect recorded anchor →", exact: true })).toHaveCount(0);
  });
}

test("terminal snapshot failure cancels pending Details and branch work without stale publication", async ({
  page,
}) => {
  let expired = false;
  let ready: () => void = () => {};
  let release: () => void = () => {};
  let admittedCount = 0;
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/snapshot?**", async (route) => {
    if (expired) await route.fulfill({ status: 410, body: "Closed session" });
    else await route.continue();
  });
  for (const pattern of ["**/api/detail?**", "**/api/branch?**"]) {
    await page.route(pattern, async (route) => {
      if (++admittedCount === 2) ready();
      await gate;
      await route.continue().catch(() => {});
    });
  }
  const failures: string[] = [];
  page.on("requestfailed", (request) => failures.push(request.url()));
  try {
    await session(page);
    await primary(page).locator(`[data-trace-id="${f.user}"]`).click();
    await admitted;
    expired = true;
    server.invalidate(2);
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    release();
    await expect.poll(() => failures.filter((url) => /\/api\/(?:detail|branch)\?/.test(url)).length).toBe(2);
    await expect(page.locator(".recorded-content")).not.toContainText("first request");
    await page.getByRole("tab", { name: "context", exact: true }).click();
    await expect(page.getByRole("button", { name: "View branch context", exact: true })).toBeDisabled();
  } finally {
    release();
  }
});

test("mobile content selection opens dismissible Details without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await session(page);
  const row = primary(page).locator(`[data-trace-id="${f.user}"]`);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible();
  await expect(page.locator(".recorded-content")).toContainText("first request");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
  await expect
    .poll(() =>
      primary(page)
        .locator(".trace-row")
        .evaluateAll((rows) =>
          rows.every((row) => {
            const text = row.querySelector(".row-title > span");
            const metrics = row.querySelector(".row-metrics");
            return !text || !metrics || text.getBoundingClientRect().right <= metrics.getBoundingClientRect().left;
          }),
        ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
  await page.screenshot({ path: test.info().outputPath("history-mobile-dark.png"), animations: "disabled" });
});
