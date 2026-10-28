import { stripVTControlCharacters } from "node:util";

const phases = ["testsAndHooksMs", "collectionMs", "setupMs", "prepareMs", "environmentMs"];
const testStates = ["passed", "failed", "skipped", "pending"];
const moduleStates = [...testStates, "queued"];

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonnegative(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} must be a finite nonnegative ${integer ? "integer" : "number"}`);
  }
  return value;
}

// Sanitize before splitting or truncating paths. Keep raw paths in the JSON file records.
function terminalText(value) {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

function packageName(filePath) {
  const parts = terminalText(filePath).replaceAll("\\", "/").split("/");
  if (parts[0] === "packages" && parts[1] && parts[2] === "test") return `packages/${parts[1]}`;
  return parts[0] === "test" ? "root" : "other";
}

function emptyTotals() {
  return {
    files: 0,
    modules: Object.fromEntries(moduleStates.map((state) => [state, 0])),
    tests: Object.fromEntries(testStates.map((state) => [state, 0])),
    ...Object.fromEntries(phases.map((phase) => [phase, 0])),
  };
}

function addFile(totals, file) {
  totals.files += 1;
  totals.modules[file.state] += 1;
  for (const state of testStates) {
    totals.tests[state] = nonnegative(totals.tests[state] + file.tests[state], `tests.${state} sum`, true);
  }
  for (const phase of phases) {
    totals[phase] = nonnegative(totals[phase] + file[phase], `${phase} sum`);
  }
}

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Validate one run. All input and JSON durations are milliseconds, never seconds. */
export function createTimingReport(input) {
  const run = record(input, "run");
  if (!["passed", "failed", "interrupted"].includes(run.reason)) throw new TypeError("invalid run reason");
  if (!Array.isArray(run.files)) throw new TypeError("files must be an array");
  const elapsedMs = run.elapsedMs === null ? null : nonnegative(run.elapsedMs, "elapsedMs");
  const unhandledErrors = nonnegative(run.unhandledErrors, "unhandledErrors", true);
  const totals = emptyTotals();
  const packages = new Map();
  const files = Array.from(run.files, (value) => {
    const source = record(value, "file");
    if (typeof source.path !== "string" || !terminalText(source.path).trim()) throw new TypeError("invalid file path");
    if (!moduleStates.includes(source.state)) throw new TypeError("invalid module state");
    const tests = record(source.tests, "tests");
    const file = {
      path: source.path,
      package: packageName(source.path),
      state: source.state,
      tests: Object.fromEntries(testStates.map((state) => [state, nonnegative(tests[state], `tests.${state}`, true)])),
      ...Object.fromEntries(phases.map((phase) => [phase, nonnegative(source[phase], phase)])),
    };
    addFile(totals, file);
    if (!packages.has(file.package)) packages.set(file.package, { name: file.package, ...emptyTotals() });
    addFile(packages.get(file.package), file);
    return file;
  });
  return {
    schemaVersion: 1,
    units: "ms",
    reason: run.reason,
    elapsedMs,
    unhandledErrors,
    totals,
    packages: [...packages.values()].sort((a, b) => compareNames(a.name, b.name)),
    files: files.sort((a, b) => compareNames(a.path, b.path)),
  };
}

function seconds(milliseconds) {
  return milliseconds === null ? "unavailable" : `${(milliseconds / 1_000).toFixed(3)} s`;
}

function label(value) {
  const characters = [...terminalText(value)];
  return characters.length > 100 ? `${characters.slice(0, 99).join("")}…` : characters.join("");
}

function topRows(rows, nameKey) {
  return [...rows]
    .sort((a, b) => b.testsAndHooksMs - a.testsAndHooksMs || compareNames(a[nameKey], b[nameKey]))
    .slice(0, 5)
    .map(
      (row) =>
        `  ${seconds(row.testsAndHooksMs)} tests/hooks | ${seconds(row.collectionMs)} collection | ${label(row[nameKey])}`,
    );
}

/** Format only reports returned by createTimingReport; terminal output is bounded. */
export function formatTimingReport(report) {
  const { totals } = report;
  return [
    `Test timing (${report.reason}): ${seconds(report.elapsedMs)} reporter interval; ${totals.files} files; ${report.unhandledErrors} unhandled errors`,
    `Tests: ${totals.tests.passed} passed, ${totals.tests.failed} failed, ${totals.tests.skipped} skipped, ${totals.tests.pending} pending`,
    `Cumulative worker time: ${seconds(totals.testsAndHooksMs)} tests/hooks; ${seconds(totals.collectionMs)} collection`,
    `Other cumulative phases: ${seconds(totals.setupMs)} setup; ${seconds(totals.prepareMs)} prepare; ${seconds(totals.environmentMs)} environment`,
    "Collection includes module imports and suite callbacks; it is not pure import time. Cumulative time is not elapsed time.",
    "Top packages by cumulative tests/hooks (up to 5; root tests grouped as root):",
    ...topRows(report.packages, "name"),
    "Top files by tests/hooks (up to 5):",
    ...topRows(report.files, "path"),
  ].join("\n");
}
