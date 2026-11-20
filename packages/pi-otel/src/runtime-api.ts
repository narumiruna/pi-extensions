import type { OtlpRuntimeConfig } from "./otlp-settings.js";
import type { CreateLangfuseRuntimeOptions, LangfuseRuntime } from "./runtime-core.js";

export type { OtlpRuntimeConfig } from "./otlp-settings.js";

export type { CreateLangfuseRuntimeOptions, LangfuseRuntime, LangfuseRuntimeConfig } from "./runtime-core.js";

export async function createLangfuseRuntime(options: CreateLangfuseRuntimeOptions = {}): Promise<LangfuseRuntime> {
  const runtime = await import("./runtime.js");
  return runtime.createLangfuseRuntime(options);
}

export async function createOtelRuntime(config: OtlpRuntimeConfig): Promise<LangfuseRuntime> {
  const runtime = await import("./runtime.js");
  return runtime.createOtelRuntime(config);
}
