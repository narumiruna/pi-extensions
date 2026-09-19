import type { CreateLangfuseRuntimeOptions, LangfuseRuntime } from "./runtime-core.js";

export {
  createPiLangfuseSession,
  type PiLangfuseSession,
  type PiLangfuseSessionOptions,
} from "./pi-session.js";
export type {
  CreateLangfuseRuntimeOptions,
  LangfuseRuntime,
  LangfuseRuntimeConfig,
} from "./runtime-core.js";

export async function createLangfuseRuntime(options: CreateLangfuseRuntimeOptions = {}): Promise<LangfuseRuntime> {
  const runtime = await import("./runtime.js");
  return runtime.createLangfuseRuntime(options);
}
