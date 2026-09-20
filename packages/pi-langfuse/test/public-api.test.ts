import assert from "node:assert/strict";
import langfuseExtension, {
  createLangfuseRuntime,
  createPiLangfuseSession,
  type LangfuseRuntime,
  type PiLangfuseSession,
} from "@narumitw/pi-langfuse";
import { test } from "vitest";

test("package root exports the default extension and typed host factories", () => {
  const runtimeFactory: () => Promise<LangfuseRuntime> = createLangfuseRuntime;
  const sessionFactory: (runtime: LangfuseRuntime) => PiLangfuseSession = createPiLangfuseSession;

  assert.equal(typeof langfuseExtension, "function");
  assert.equal(typeof runtimeFactory, "function");
  assert.equal(typeof sessionFactory, "function");
});
