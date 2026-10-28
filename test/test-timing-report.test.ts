import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, test } from "vitest";

type TestState = "passed" | "failed" | "skipped" | "pending";
type ModuleState = TestState | "queued";

interface Phases {
  testsAndHooksMs: number;
  collectionMs: number;
  setupMs: number;
  prepareMs: number;
  environmentMs: number;
}

interface FileTiming extends Phases {
  path: string;
  state: ModuleState;
  tests: Record<TestState, number>;
}

interface Totals extends Phases {
  files: number;
  modules: Record<ModuleState, number>;
  tests: Record<TestState, number>;
}

interface TimingReport {
  schemaVersion: number;
  units: "ms";
  reason: "passed" | "failed" | "interrupted";
  elapsedMs: number | null;
  unhandledErrors: number;
  totals: Totals;
  packages: (Totals & { name: string })[];
  files: (FileTiming & { package: string })[];
}

interface TimingHelper {
  createTimingReport(input: unknown): TimingReport;
  formatTimingReport(report: TimingReport): string;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const helperUrl = pathToFileURL(path.join(repositoryRoot, "scripts", "test-timing-report.mjs")).href;
let helper: TimingHelper;

beforeAll(async () => {
  helper = (await import(helperUrl)) as TimingHelper;
});

function file(filePath: string, overrides: Partial<FileTiming> = {}): FileTiming {
  return {
    path: filePath,
    state: "passed",
    tests: { passed: 1, failed: 0, skipped: 0, pending: 0 },
    testsAndHooksMs: 1_250,
    collectionMs: 2_500,
    setupMs: 25,
    prepareMs: 10,
    environmentMs: 5,
    ...overrides,
  };
}

function run(files: FileTiming[] = [], overrides: Record<string, unknown> = {}) {
  return { elapsedMs: 1_000, reason: "passed", unhandledErrors: 0, files, ...overrides };
}

test("timing reports aggregate packages and root files without confusing elapsed and cumulative time", () => {
  const input = run([
    file("packages/pi-a/test/first.test.ts"),
    file("packages\\pi-a\\test\\second.test.ts", { testsAndHooksMs: 750.125 }),
    file("packages/pi-b/test/other.test.ts", { testsAndHooksMs: 500 }),
    file("test/root.test.ts", { testsAndHooksMs: 250 }),
  ]);
  const original = JSON.stringify(input);
  const report = helper.createTimingReport(input);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.units, "ms");
  assert.equal(report.elapsedMs, 1_000);
  assert.equal(report.totals.testsAndHooksMs, 2_750.125);
  assert.equal(report.totals.collectionMs, 10_000);
  assert.equal(report.totals.setupMs, 100);
  assert.equal(report.totals.prepareMs, 40);
  assert.equal(report.totals.environmentMs, 20);
  assert.equal(report.totals.tests.passed, 4);
  assert.equal(report.totals.modules.passed, 4);
  assert.deepEqual(
    report.packages.map((entry) => entry.name),
    ["packages/pi-a", "packages/pi-b", "root"],
  );
  assert.equal(report.packages[0]?.files, 2);
  assert.equal(report.packages[0]?.testsAndHooksMs, 2_000.125);
  assert.equal(JSON.stringify(input), original);
});

test("skipped modules and tests retain collection cost and remain distinct from passed tests", () => {
  const report = helper.createTimingReport(
    run(
      [
        file("packages/pi-a/test/skipped.test.ts", {
          state: "skipped",
          testsAndHooksMs: 0,
          tests: { passed: 0, failed: 0, skipped: 3, pending: 0 },
        }),
        file("test/mixed.test.ts", { tests: { passed: 1, failed: 1, skipped: 2, pending: 1 } }),
      ],
      { reason: "failed", unhandledErrors: 2 },
    ),
  );

  assert.equal(report.totals.files, 2);
  assert.equal(report.totals.modules.skipped, 1);
  assert.deepEqual(report.totals.tests, { passed: 1, failed: 1, skipped: 5, pending: 1 });
  assert.equal(report.totals.testsAndHooksMs, 1_250);
  assert.equal(report.totals.collectionMs, 5_000);
  assert.equal(report.unhandledErrors, 2);
  assert.equal(report.reason, "failed");
  assert.match(helper.formatTimingReport(report), /5 skipped, 1 pending/u);
});

test("empty and interrupted runs preserve the reason and unavailable elapsed time", () => {
  for (const reason of ["passed", "failed", "interrupted"] as const) {
    const report = helper.createTimingReport(run([], { reason, elapsedMs: null, unhandledErrors: 1 }));
    assert.equal(report.reason, reason);
    assert.equal(report.elapsedMs, null);
    assert.equal(report.totals.files, 0);
    assert.equal(report.totals.testsAndHooksMs, 0);
    assert.deepEqual(report.files, []);
    assert.deepEqual(report.packages, []);
    assert.match(helper.formatTimingReport(report), /unavailable reporter interval; 0 files; 1 unhandled errors/u);
  }
  const report = helper.createTimingReport(
    run(
      [
        file("test/queued.test.ts", {
          state: "queued",
          testsAndHooksMs: 0,
          collectionMs: 0,
          setupMs: 0,
          prepareMs: 0,
          environmentMs: 0,
          tests: { passed: 0, failed: 0, skipped: 0, pending: 0 },
        }),
        file("test/pending.test.ts", { state: "pending", tests: { passed: 0, failed: 0, skipped: 0, pending: 2 } }),
        file("test/collection-failed.test.ts", {
          state: "failed",
          tests: { passed: 0, failed: 0, skipped: 0, pending: 0 },
        }),
      ],
      { reason: "interrupted" },
    ),
  );
  assert.equal(report.totals.modules.queued, 1);
  assert.equal(report.totals.modules.pending, 1);
  assert.equal(report.totals.modules.failed, 1);
  assert.equal(report.totals.tests.pending, 2);
});

test("only terminal formatting converts milliseconds to seconds", () => {
  const report = helper.createTimingReport(run([file("test/units.test.ts")], { elapsedMs: 123.25 }));
  const text = helper.formatTimingReport(report);
  assert.equal(report.files[0]?.testsAndHooksMs, 1_250);
  assert.equal(report.files[0]?.collectionMs, 2_500);
  assert.equal(report.elapsedMs, 123.25);
  assert.match(text, /0\.123 s reporter interval/u);
  assert.match(text, /1\.250 s tests\/hooks; 2\.500 s collection/u);
  assert.match(text, /Collection includes module imports and suite callbacks; it is not pure import time/u);
  assert.match(text, /Cumulative time is not elapsed time/u);
});

test("malformed run records fail validation instead of producing plausible zero totals", () => {
  for (const input of [
    null,
    [],
    {},
    run([], { files: {} }),
    run([], { reason: "cancelled" }),
    run([], { elapsedMs: undefined }),
    run([], { elapsedMs: "1000" }),
    run([], { elapsedMs: -1 }),
    run([], { elapsedMs: Number.NaN }),
    run([], { unhandledErrors: 0.5 }),
    run([], { unhandledErrors: -1 }),
    run([], { files: [null] }),
    run([], { files: Array(1) }),
    run([file("")]),
    run([file("\n\t")]),
    run([file("test/a.test.ts", { state: "unknown" as ModuleState })]),
    run([file("test/a.test.ts", { tests: { passed: -1, failed: 0, skipped: 0, pending: 0 } })]),
    run([file("test/a.test.ts", { tests: { passed: 0.5, failed: 0, skipped: 0, pending: 0 } })]),
    run([file("test/a.test.ts", { tests: {} as FileTiming["tests"] })]),
  ]) {
    assert.throws(() => helper.createTimingReport(input), TypeError);
  }
  for (const phase of ["testsAndHooksMs", "collectionMs", "setupMs", "prepareMs", "environmentMs"]) {
    for (const invalid of [undefined, null, "1", -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(
        () =>
          helper.createTimingReport(
            run([], {
              files: [{ ...file("test/a.test.ts"), [phase]: invalid }],
            }),
          ),
        TypeError,
      );
    }
  }
  assert.throws(
    () =>
      helper.createTimingReport(
        run([
          file("test/a.test.ts", { collectionMs: Number.MAX_VALUE }),
          file("test/b.test.ts", { collectionMs: Number.MAX_VALUE }),
        ]),
      ),
    TypeError,
  );
});

test("terminal output shows only the top five packages and files while JSON retains every raw path", () => {
  const files = Array.from({ length: 20 }, (_, index) =>
    file(`packages/pi-${index}/test/${"long".repeat(40)}\u001b]0;title\u0007\u001b[31m\n\r\t\u009b\u202e.test.ts`, {
      testsAndHooksMs: (index + 1) * 1_000,
    }),
  );
  const report = helper.createTimingReport(run(files));
  const original = JSON.stringify(report);
  const text = helper.formatTimingReport(report);

  assert.equal(report.packages.length, 20);
  assert.equal(report.files.length, 20);
  assert.equal(report.files.find((entry) => entry.path === files[0]?.path)?.path, files[0]?.path);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  ")).length, 10);
  assert.ok(text.split("\n").length <= 17);
  assert.ok(text.split("\n").every((line) => [...line].length <= 200));
  assert.doesNotMatch(text.replaceAll("\n", ""), /[\p{Cc}\p{Cf}]/u);
  assert.doesNotMatch(text, /title|packages\/pi-14\//u);
  assert.match(text, /packages\/pi-19/u);
  assert.equal(JSON.stringify(report), original);
});

test("path controls are removed before package grouping and tied rankings use stable path order", () => {
  const rawPath = "packages/\u001b[31mpi-a\u001b[0m/test/new\nline.test.ts";
  const report = helper.createTimingReport(run([file("test/z.test.ts"), file(rawPath), file("test/a.test.ts")]));
  assert.equal(report.files.find((entry) => entry.path === rawPath)?.package, "packages/pi-a");
  assert.match(helper.formatTimingReport(report), /packages\/pi-a\/test\/newline.test.ts/u);
  const text = helper.formatTimingReport(report);
  assert.ok(text.indexOf("test/a.test.ts") < text.indexOf("test/z.test.ts"));
});
