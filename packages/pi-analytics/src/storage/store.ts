import type { SettledRun } from "../types.js";
import { AnalyticsGenerationChangedError, AnalyticsRunFiles, type ClearAnalyticsResult } from "./files.js";
import { type AnalyticsSnapshot, querySnapshot, type TimeRange } from "./queries.js";

export class AnalyticsStore {
  private readonly files: AnalyticsRunFiles;

  constructor(
    rootPath: string,
    dependencies: {
      files?: AnalyticsRunFiles;
      createId?: () => string;
      writeTimeoutMs?: number;
    } = {},
  ) {
    this.files =
      dependencies.files ??
      new AnalyticsRunFiles(rootPath, {
        createId: dependencies.createId,
        writeTimeoutMs: dependencies.writeTimeoutMs,
      });
  }

  get path(): string {
    return this.files.path;
  }

  recordRun(run: SettledRun, signal?: AbortSignal): Promise<void> {
    return this.files.append(run, signal);
  }

  async getSnapshot(range: TimeRange, signal?: AbortSignal): Promise<AnalyticsSnapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await querySnapshot(this.files.read(signal), range, signal);
      } catch (error) {
        if (!(error instanceof AnalyticsGenerationChangedError) || attempt > 0) throw error;
      }
    }
    throw new AnalyticsGenerationChangedError();
  }

  clearAll(signal?: AbortSignal): Promise<ClearAnalyticsResult> {
    return this.files.clear(signal);
  }

  close(): Promise<void> {
    return this.files.close();
  }
}
