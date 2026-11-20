import assert from "node:assert/strict";
import otelExtension, {
  createLangfuseRuntime,
  createOtelRuntime,
  createPiLangfuseSession,
  type LangfuseRuntime,
  type OtlpRuntimeConfig,
  type PiLangfuseSession,
} from "@narumitw/pi-otel";
import { test } from "vitest";

test("package root exports the default extension and typed host factories", () => {
  const runtimeFactory: () => Promise<LangfuseRuntime> = createLangfuseRuntime;
  const sessionFactory: (runtime: LangfuseRuntime) => PiLangfuseSession = createPiLangfuseSession;

  const otlpFactory: (config: OtlpRuntimeConfig) => Promise<LangfuseRuntime> = createOtelRuntime;
  assert.equal(typeof otelExtension, "function");
  assert.equal(typeof otlpFactory, "function");
  assert.equal(typeof runtimeFactory, "function");
  assert.equal(typeof sessionFactory, "function");
});
