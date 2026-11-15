#!/usr/bin/env node

import concurrently from "concurrently";

export async function runChecks({ execute = concurrently } = {}) {
  const checks = ["check:biome", "check:boundaries", "check:dependencies", "typecheck"];
  const env = { ...process.env, PI_EXTENSIONS_BUILD_READY: "1" };

  console.log(`Running checks in parallel: ${checks.join(", ")}`);
  const { result } = execute(
    checks.map((check) => ({ command: `npm:${check}`, name: check, env })),
    { prefix: "name", prefixColors: ["auto"] },
  );

  try {
    await result;
    return 0;
  } catch {
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runChecks();
}
