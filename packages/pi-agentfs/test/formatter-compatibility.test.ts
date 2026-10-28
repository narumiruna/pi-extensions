import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const commonjs = require("just-bash") as typeof import("just-bash");
const formatterRequire = createRequire(require.resolve("just-bash"));

it("resolves just-bash's formatter to the replacement package", () => {
  const manifest = JSON.parse(readFileSync(formatterRequire.resolve("sprintf-js/package.json"), "utf8"));
  expect(manifest.name).toBe("@lvcabral/sprintf");
});

// Cover just-bash's native conversion branches and the formatter-backed fallbacks,
// including the JS-specific conversions that a POSIX-only replacement would lose.
describe.each([
  ["ESM", Bash],
  ["CommonJS", commonjs.Bash],
] as const)("%s formatter compatibility", (_name, Shell) => {
  it.each([
    ["printf '%s' value", "value"],
    ["printf '%+s' value", "value"],
    ["printf '%03s' x", "  x"],
    ["printf '%-5s' x", "x    "],
    ["printf '%.2s' value", "va"],
    ["printf '%d %i %u %o %x %X' 42 42 42 42 42 42", "42 42 42 52 2a 2A"],
    ["printf '%+05d' 42", "+0042"],
    ["printf '%#.4o %#x' 8 255", "0010 0xff"],
    ["printf '%.2e %.2f %.2g' 1.25 1.25 1.25", "1.25e+00 1.25 1.3"],
    ["printf '%c %q %b' x 'a b' 'a\\nb'", "x a\\ b a\nb"],
    ["printf '%%'", "%"],
    ["printf '%j' value", '"value"'],
    ["printf '%5j' value", '"value"'],
    ["printf '%t' value", "true"],
    ["printf '%.2t' value", "tr"],
    ["printf '%T' value", "string"],
    ["printf '%v' value", "value"],
    ["printf '%*.*f' 8 2 1.25", "    1.25"],
    ["printf '%.0g' 1", "1"],
    ["printf '%.100f' 1", `1.${"0".repeat(100)}`],
  ])("preserves %s", async (command, stdout) => {
    await expect(new Shell().exec(command)).resolves.toMatchObject({ stdout, stderr: "", exitCode: 0 });
  });

  it.each([
    "printf '%.101f' 1",
    "printf '%.101e' 1",
    "printf '%.101g' 1",
    "printf '%.999999999999f' 1",
    "printf '%999999999999s' x",
    "printf '%z' value",
  ])("contains invalid input from %s", async (command) => {
    const shell = new Shell();
    const result = await shell.exec(command);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).toBe("");
    await expect(shell.exec("printf '%s' recovered")).resolves.toMatchObject({
      stdout: "recovered",
      stderr: "",
      exitCode: 0,
    });
  });
});
