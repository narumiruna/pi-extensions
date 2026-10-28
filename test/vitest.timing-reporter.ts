import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { Reporter, TestModule } from "vitest/node";

type RunEndArguments = Parameters<NonNullable<Reporter["onTestRunEnd"]>>;

interface TimingHelper {
  createTimingReport(input: unknown): unknown;
  formatTimingReport(report: unknown): string;
}

const reportRelativePath = "node_modules/.cache/pi-extensions-test-report.json";

export default class TestTimingReporter implements Reporter {
  private root = process.cwd();
  private startedAt: number | undefined;
  private log: (message: string) => void = (message) => console.log(message);
  private warn: (message: string) => void = (message) => console.warn(message);

  onInit(vitest: Parameters<NonNullable<Reporter["onInit"]>>[0]): void {
    this.root = vitest.config.root;
    this.log = (message) => vitest.logger.log(message);
    this.warn = (message) => vitest.logger.warn(message);
  }

  onTestRunStart(): void {
    // Run-hook elapsed time excludes CLI startup and discovery; the outer runner times that stage.
    this.startedAt = performance.now();
    try {
      // This sibling of the compiled-test directory survives its reset by run-tests.mjs.
      // Clear an earlier run so an interrupted process cannot leave a seemingly current report.
      rmSync(path.join(this.root, reportRelativePath), { force: true });
    } catch {
      this.warn("Could not clear the previous test timing report; it may be stale.");
    }
  }

  async onTestRunEnd(
    modules: readonly TestModule[],
    errors: RunEndArguments[1],
    reason: RunEndArguments[2],
  ): Promise<void> {
    const elapsedMs = this.startedAt === undefined ? null : performance.now() - this.startedAt;
    this.startedAt = undefined;
    const reportPath = path.join(this.root, reportRelativePath);
    const temporaryPath = `${reportPath}.${process.pid}.tmp`;
    try {
      // Variable URL matches root tooling tests and avoids copying JS helpers into the TS output.
      const helperUrl = pathToFileURL(path.join(this.root, "scripts", "test-timing-report.mjs")).href;
      const helper = (await import(helperUrl)) as TimingHelper;
      const report = helper.createTimingReport({
        elapsedMs,
        reason,
        unhandledErrors: errors.length,
        files: modules.map((module) => {
          const diagnostic = module.diagnostic();
          const tests = { passed: 0, failed: 0, skipped: 0, pending: 0 };
          for (const test of module.children.allTests()) tests[test.result().state] += 1;
          return {
            path: path.relative(this.root, module.moduleId),
            state: module.state(),
            tests,
            testsAndHooksMs: diagnostic.duration,
            // Includes suite callbacks as well as imports. Do not call this pure import time.
            // Vitest returns zero diagnostics when a module has not run, including queued files.
            collectionMs: diagnostic.collectDuration,
            setupMs: diagnostic.setupDuration,
            prepareMs: diagnostic.prepareDuration,
            environmentMs: diagnostic.environmentSetupDuration,
          };
        }),
      });
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, reportPath);
      this.log(helper.formatTimingReport(report));
      this.log(`Full test timing report: ${reportRelativePath}`);
    } catch {
      // Reporting must not replace a failed or interrupted test run's exit status.
      // Do not print errors or raw paths, which can contain terminal controls.
      this.warn("Test timing report unavailable: collection or report publication failed.");
    } finally {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        this.warn("Could not remove the temporary test timing report.");
      }
    }
  }
}
